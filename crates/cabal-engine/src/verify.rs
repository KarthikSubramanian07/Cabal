//! Replay verification: does the engine still reproduce a recorded game?
//!
//! [`Game::verify_saved`] replays a saved game phase by phase and compares
//! everything the file records with what the engine produces: the orders as
//! adjudicated, the result codes, who was dislodged and from where, the phase
//! names, units, centres, retreat options, build allowances and the outcome.
//! Every difference becomes a [`Divergence`]. After a difference in the board
//! the replay continues from the recorded state, so one bad phase is reported
//! once instead of poisoning everything after it.
//!
//! Files written by Cabal (those with a `cabal` block) are held to an exact
//! standard, ending with a byte-for-byte comparison of the re-exported game.
//! Files from other tools are compared on what they actually record: they may
//! omit implicit holds, list holdings in another order and leave results out.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::game::{Game, Status};
use crate::json::{
    BuildInfo, MilaPhase, MilaState, ReplayError, SavedGame, SavedOutcome, edition_name,
    phase_to_mila, power_name, recorded_orders, state_from_mila, state_to_mila_with,
};
use crate::rulebook::Rulebook;

/// What part of the record disagrees with the engine.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DivergenceField {
    /// An order could not be read, or was adjudicated as a different order.
    Orders,
    /// Result codes (`bounce`, `cut`, `void`, `dislodged`, ...).
    Results,
    /// Which units were dislodged, by whom, and where standoffs occurred.
    Dislodged,
    /// The name of a phase, hence the calendar.
    PhaseName,
    Units,
    Centers,
    /// Where a dislodged unit may retreat.
    Retreats,
    /// Build allowance and build sites.
    Builds,
    /// How the game ended.
    Outcome,
    /// The re-exported game is not the recorded file (Cabal-written files only).
    Export,
}

/// One disagreement between the record and the engine.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Divergence {
    /// The phase being adjudicated when the difference appeared.
    pub phase: String,
    pub field: DivergenceField,
    /// The power, unit or order concerned.
    pub subject: String,
    /// What the file records.
    pub expected: String,
    /// What the engine produced.
    pub got: String,
}

impl std::fmt::Display for Divergence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let field = serde_json::to_value(self.field)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        write!(
            f,
            "{} {} {}: recorded [{}], engine [{}]",
            self.phase, field, self.subject, self.expected, self.got
        )
    }
}

/// The result of replaying one saved game.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct ReplayReport {
    pub id: String,
    pub map: String,
    /// Edition the replay ran under.
    pub rulebook: String,
    /// Engine version that recorded the game, when the file says.
    pub recorded_by: Option<String>,
    /// Engine version that replayed it.
    pub engine: String,
    /// Whether the file was held to the exact standard of Cabal-written files.
    pub strict: bool,
    /// Number of phases adjudicated.
    pub phases: usize,
    pub divergences: Vec<Divergence>,
}

impl ReplayReport {
    pub fn is_clean(&self) -> bool {
        self.divergences.is_empty()
    }
}

fn canon(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase()
}

fn set_of(list: &[String]) -> BTreeSet<String> {
    list.iter().map(|s| canon(s)).collect()
}

/// Result codes are lower case words; only stray whitespace is tidied.
fn codes_of(list: &[String]) -> BTreeSet<String> {
    list.iter().map(|s| s.trim().to_ascii_lowercase()).collect()
}

fn show(set: &BTreeSet<String>) -> String {
    set.iter().cloned().collect::<Vec<_>>().join(", ")
}

struct Checker {
    strict: bool,
    out: Vec<Divergence>,
}

impl Checker {
    fn push(
        &mut self,
        phase: &str,
        field: DivergenceField,
        subject: impl Into<String>,
        expected: impl Into<String>,
        got: impl Into<String>,
    ) {
        self.out.push(Divergence {
            phase: phase.to_string(),
            field,
            subject: subject.into(),
            expected: expected.into(),
            got: got.into(),
        });
    }

    /// Compare one keyed family of lists as sets. In strict mode every key on
    /// either side is checked; otherwise only keys the record mentions.
    fn sets(
        &mut self,
        phase: &str,
        field: DivergenceField,
        prefix: &str,
        recorded: &BTreeMap<String, Vec<String>>,
        engine: &BTreeMap<String, Vec<String>>,
        both_sides: bool,
    ) -> bool {
        self.sets_by(phase, field, prefix, recorded, engine, both_sides, set_of)
    }

    #[allow(clippy::too_many_arguments)]
    fn sets_by(
        &mut self,
        phase: &str,
        field: DivergenceField,
        prefix: &str,
        recorded: &BTreeMap<String, Vec<String>>,
        engine: &BTreeMap<String, Vec<String>>,
        both_sides: bool,
        set_of: fn(&[String]) -> BTreeSet<String>,
    ) -> bool {
        let mut keys: BTreeSet<&String> = recorded.keys().collect();
        if both_sides {
            keys.extend(engine.keys());
        }
        let mut differs = false;
        for key in keys {
            let want = set_of(recorded.get(key).map_or(&[][..], Vec::as_slice));
            let have = set_of(engine.get(key).map_or(&[][..], Vec::as_slice));
            if want != have {
                differs = true;
                self.push(
                    phase,
                    field,
                    format!("{prefix}{key}"),
                    show(&want),
                    show(&have),
                );
            }
        }
        differs
    }

    /// Compare a recorded state with the engine's. Returns whether the board
    /// itself (units, centres, dislodgements or the phase) differs.
    fn state(&mut self, phase: &str, recorded: &MilaState, engine: &MilaState) -> bool {
        let split = |m: &BTreeMap<String, Vec<String>>, dislodged: bool| {
            m.iter()
                .map(|(k, v)| {
                    let units = v
                        .iter()
                        .filter(|u| u.starts_with('*') == dislodged)
                        .map(|u| u.trim_start_matches('*').to_string())
                        .collect();
                    (k.clone(), units)
                })
                .collect::<BTreeMap<String, Vec<String>>>()
        };
        let mut board = false;
        if canon(&recorded.name) != canon(&engine.name) {
            board = true;
            self.push(
                phase,
                DivergenceField::PhaseName,
                "next phase",
                recorded.name.as_str(),
                engine.name.as_str(),
            );
        }
        // other writers omit powers that hold nothing, so both sides always count
        board |= self.sets(
            phase,
            DivergenceField::Units,
            "",
            &split(&recorded.units, false),
            &split(&engine.units, false),
            true,
        );
        board |= self.sets(
            phase,
            DivergenceField::Dislodged,
            "",
            &split(&recorded.units, true),
            &split(&engine.units, true),
            true,
        );
        board |= self.sets(
            phase,
            DivergenceField::Centers,
            "",
            &recorded.centers,
            &engine.centers,
            true,
        );
        if self.strict && recorded.cabal != engine.cabal {
            board = true;
            let text = |s: &MilaState| {
                s.cabal.as_ref().map_or(String::new(), |c| {
                    let mut parts: Vec<String> = c
                        .dislodged
                        .iter()
                        .map(|d| {
                            let how = if d.by_convoy { " by convoy" } else { "" };
                            format!("{} from {}{how}", d.unit, d.attacker_from)
                        })
                        .collect();
                    if !c.standoffs.is_empty() {
                        parts.push(format!("standoffs {}", c.standoffs.join(" ")));
                    }
                    parts.join(", ")
                })
            };
            self.push(
                phase,
                DivergenceField::Dislodged,
                "attackers and standoffs",
                text(recorded),
                text(engine),
            );
        }
        let empty = BTreeMap::new();
        let powers: BTreeSet<&String> = if self.strict {
            recorded
                .retreats
                .keys()
                .chain(engine.retreats.keys())
                .collect()
        } else {
            recorded.retreats.keys().collect()
        };
        for power in powers {
            let strict = self.strict;
            self.sets(
                phase,
                DivergenceField::Retreats,
                &format!("{power} "),
                recorded.retreats.get(power).unwrap_or(&empty),
                engine.retreats.get(power).unwrap_or(&empty),
                strict,
            );
        }
        // Other writers fill `builds` in every phase, list home centres even
        // when units must be removed, and cap a positive count at the number of
        // free build sites (MILA does all three). Outside Cabal's own files only
        // the capped allowance of an adjustment phase is comparable.
        let powers: BTreeSet<&String> = if self.strict {
            recorded.builds.keys().chain(engine.builds.keys()).collect()
        } else {
            engine
                .builds
                .keys()
                .filter(|p| recorded.builds.contains_key(*p))
                .collect()
        };
        for power in powers {
            let strict = self.strict;
            let text = |b: Option<&BuildInfo>| {
                b.map_or(String::new(), |b| {
                    if !strict {
                        let sites = b.homes.len() as i32;
                        return b.count.min(sites.max(0)).max(b.count.min(0)).to_string();
                    }
                    let mut homes = b.homes.clone();
                    homes.sort();
                    format!("{} at {}", b.count, homes.join(" "))
                })
            };
            let want = text(recorded.builds.get(power));
            let have = text(engine.builds.get(power));
            if want != have {
                self.push(phase, DivergenceField::Builds, power.as_str(), want, have);
            }
        }
        board
    }

    /// Compare what was ordered and how it turned out with the engine's export.
    fn adjudication(&mut self, recorded: &MilaPhase, engine: &MilaPhase) {
        let phase = recorded.name.as_str();
        if self.strict {
            // Cabal records every unit's order, implicit holds included.
            self.sets(
                phase,
                DivergenceField::Orders,
                "",
                &recorded.orders,
                &engine.orders,
                true,
            );
        }
        if recorded.results.is_empty() && !self.strict {
            return;
        }
        // MILA marks plain success with an empty code; it carries no information.
        let codes = |m: &BTreeMap<String, Vec<String>>| {
            m.iter()
                .map(|(k, v)| {
                    let v = v.iter().filter(|c| !c.is_empty()).cloned().collect();
                    (canon(k), v)
                })
                .collect::<BTreeMap<String, Vec<String>>>()
        };
        let strict = self.strict;
        self.sets_by(
            phase,
            DivergenceField::Results,
            "",
            &codes(&recorded.results),
            &codes(&engine.results),
            strict,
            codes_of,
        );
    }
}

impl Game {
    /// Replay `saved` and report every way the engine disagrees with it.
    ///
    /// `rulebook` is used only when the file does not record one. An `Err` means
    /// the file could not be replayed at all (unknown map or power, no phases,
    /// unreadable first state); disagreements are in the report, never an error.
    pub fn verify_saved(
        saved: &SavedGame,
        rulebook: Rulebook,
    ) -> Result<ReplayReport, ReplayError> {
        let mut game = Game::begin_saved(saved, rulebook)?;
        let map = game.map();
        let strict = saved.cabal.is_some();
        let mut check = Checker {
            strict,
            out: Vec::new(),
        };
        let last = saved.phases.len() - 1;
        let mut adjudicated = 0;
        let mut complete = true;
        for (i, phase) in saved.phases.iter().enumerate() {
            if !phase.messages.is_empty() {
                game.press
                    .insert(phase.state.name.clone(), phase.messages.clone());
            }
            if i == 0 {
                let engine = state_to_mila_with(map, &game.state, game.rulebook);
                check.state(&phase.name, &phase.state, &engine);
            }
            if i == last {
                break;
            }
            let current = game.phase().to_string();
            if canon(&phase.name) != current {
                check.push(
                    &phase.name,
                    DivergenceField::PhaseName,
                    "phase",
                    phase.name.as_str(),
                    current.as_str(),
                );
            }
            if let Status::Solo { winner } = game.status {
                check.push(
                    &phase.name,
                    DivergenceField::Outcome,
                    "game",
                    "play continues",
                    format!("solo by {}", power_name(map, winner)),
                );
                complete = false;
                break;
            }
            let (typed, unreadable) = recorded_orders(map, game.phase().kind, &phase.orders)?;
            for (text, reason) in unreadable {
                check.push(
                    &phase.name,
                    DivergenceField::Orders,
                    text,
                    "a readable order",
                    reason,
                );
            }
            game.process(&typed).map_err(|_| ReplayError::Finished)?;
            adjudicated += 1;
            let record = game.history.last().expect("phase just recorded");
            check.adjudication(phase, &phase_to_mila(map, game.rulebook, record));

            let next = &saved.phases[i + 1];
            if next.name != "COMPLETED" && canon(&next.name) != canon(&next.state.name) {
                check.push(
                    &phase.name,
                    DivergenceField::PhaseName,
                    "next phase label",
                    next.name.as_str(),
                    next.state.name.as_str(),
                );
            }
            if next.name == "COMPLETED" && i + 1 != last {
                check.push(
                    &phase.name,
                    DivergenceField::PhaseName,
                    "next phase label",
                    "COMPLETED",
                    "a phase before the end of the file",
                );
            }
            let engine = state_to_mila_with(map, &game.state, game.rulebook);
            if check.state(&phase.name, &next.state, &engine) {
                // carry on from the record so later phases are judged on their own
                match state_from_mila(map, &next.state) {
                    Ok(state) => {
                        game.state = state;
                        if matches!(game.status, Status::Solo { .. }) && i + 1 != last {
                            game.status = Status::Active;
                        }
                    }
                    Err(e) => {
                        check.push(
                            &phase.name,
                            DivergenceField::PhaseName,
                            "next state",
                            "a readable state",
                            e.to_string(),
                        );
                        complete = false;
                        break;
                    }
                }
            }
        }

        if complete {
            let engine_solo = match game.status {
                Status::Solo { winner } => Some(power_name(map, winner)),
                _ => None,
            };
            let recorded = saved.cabal.as_ref().map(|m| &m.outcome);
            let describe = |solo: &Option<String>| match solo {
                Some(w) => format!("solo by {w}"),
                None => "no solo".to_string(),
            };
            let recorded_solo = match recorded {
                Some(SavedOutcome::Solo { winner }) => Some(Some(canon(winner))),
                Some(_) => Some(None),
                None => None,
            };
            if let Some(want) = recorded_solo {
                if want != engine_solo {
                    let phase = saved.phases[last].name.clone();
                    check.push(
                        &phase,
                        DivergenceField::Outcome,
                        "game",
                        describe(&want),
                        describe(&engine_solo),
                    );
                }
            }
        }

        if strict && check.out.is_empty() {
            game.adopt_outcome(saved)?;
            let exported = game.to_saved(&saved.id);
            if exported != *saved {
                let (phase, part) = first_difference(saved, &exported);
                check.push(
                    &phase,
                    DivergenceField::Export,
                    part,
                    "the recorded file",
                    "a different export",
                );
            }
        }

        Ok(ReplayReport {
            id: saved.id.clone(),
            map: saved.map.clone(),
            rulebook: edition_name(game.rulebook).to_string(),
            recorded_by: saved.cabal.as_ref().map(|m| m.engine.clone()),
            engine: crate::VERSION.to_string(),
            strict,
            phases: adjudicated,
            divergences: check.out,
        })
    }
}

/// Name the first place two saved games differ, for the export check.
fn first_difference(recorded: &SavedGame, exported: &SavedGame) -> (String, String) {
    for (a, b) in recorded.phases.iter().zip(&exported.phases) {
        let part = if a.name != b.name {
            "phase name"
        } else if a.state != b.state {
            "state"
        } else if a.orders != b.orders {
            "orders"
        } else if a.results != b.results {
            "results"
        } else if a.messages != b.messages {
            "messages"
        } else {
            continue;
        };
        return (a.name.clone(), part.to_string());
    }
    let part = if recorded.phases.len() != exported.phases.len() {
        "number of phases"
    } else if recorded.rules != exported.rules {
        "rules"
    } else if recorded.cabal != exported.cabal {
        "cabal block"
    } else {
        "header"
    };
    (String::new(), part.to_string())
}
