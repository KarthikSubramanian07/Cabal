//! MILA / Cicero compatible saved game format.
//!
//! The shape follows `diplomacy.utils.export.to_saved_game_format` so that every
//! published AI Diplomacy harness and visualiser can read Cabal games. Powers are
//! named with their full upper case names (`FRANCE`), units as `A PAR` / `F STP/NC`,
//! dislodged units carry a `*` prefix in retreat phases, and results use the
//! MILA vocabulary (`bounce`, `cut`, `void`, `dislodged`, `no convoy`, `disband`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::game::{Game, PhaseRecord, PhaseResult};
use crate::geo::{Map, Power, ProvinceId, Region, UnitKind};
use crate::order::{AnyOrder, Unit};
use crate::outcome::{
    ConvoyOutcome, HoldOutcome, MoveOutcome, OrderOutcome, RetreatOutcome, SupportOutcome,
};
use crate::state::{GameState, Phase, PhaseKind};
use crate::text::{adjust_text, order_text, retreat_text, unit_text};

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct BuildInfo {
    pub count: i32,
    pub homes: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct MilaState {
    pub name: String,
    pub units: BTreeMap<String, Vec<String>>,
    pub centers: BTreeMap<String, Vec<String>>,
    pub homes: BTreeMap<String, Vec<String>>,
    pub retreats: BTreeMap<String, BTreeMap<String, Vec<String>>>,
    pub builds: BTreeMap<String, BuildInfo>,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct MilaMessage {
    pub sender: String,
    pub recipient: String,
    pub phase: String,
    pub time_sent: u64,
    pub message: String,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct MilaPhase {
    pub name: String,
    pub state: MilaState,
    pub orders: BTreeMap<String, Vec<String>>,
    pub results: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub messages: Vec<MilaMessage>,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct SavedGame {
    pub id: String,
    pub map: String,
    #[serde(default)]
    pub rules: Vec<String>,
    pub phases: Vec<MilaPhase>,
}

fn power_name(map: &Map, p: Power) -> String {
    map.power(p).name.to_ascii_uppercase()
}

fn find_power(map: &Map, name: &str) -> Option<Power> {
    map.find_power(name)
}

/// Serialise a state in MILA layout.
pub fn state_to_mila(map: &Map, state: &GameState) -> MilaState {
    let mut units: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut centers: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut homes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut retreats: BTreeMap<String, BTreeMap<String, Vec<String>>> = BTreeMap::new();
    let mut builds: BTreeMap<String, BuildInfo> = BTreeMap::new();
    for p in map.power_ids() {
        let name = power_name(map, p);
        units.insert(
            name.clone(),
            state
                .position
                .units_of(p)
                .map(|u| unit_text(map, u))
                .collect(),
        );
        centers.insert(
            name.clone(),
            state
                .position
                .centers_of(p)
                .map(|c| map.province(c).name.to_ascii_uppercase())
                .collect(),
        );
        homes.insert(
            name.clone(),
            map.homes(p)
                .iter()
                .map(|&c| map.province(c).name.to_ascii_uppercase())
                .collect(),
        );
        if state.phase.kind == PhaseKind::Retreat {
            let mut r = BTreeMap::new();
            for (province, options) in crate::legal::legal_retreats(map, state, p) {
                let unit = state
                    .dislodged
                    .iter()
                    .find(|d| d.unit.province() == province)
                    .map(|d| d.unit)
                    .expect("dislodged");
                units
                    .get_mut(&name)
                    .unwrap()
                    .push(format!("*{}", unit_text(map, &unit)));
                let dests: Vec<String> = options
                    .iter()
                    .filter_map(|o| match o.command {
                        crate::order::RetreatCommand::Retreat { dest, coast } => {
                            Some(map.region_name(Region::new(dest, coast)))
                        }
                        _ => None,
                    })
                    .collect();
                r.insert(unit_text(map, &unit), dests);
            }
            retreats.insert(name.clone(), r);
        }
        if state.phase.kind == PhaseKind::Adjustment {
            let (count, options) = crate::legal::legal_adjustments(
                map,
                &state.position,
                crate::rulebook::Rulebook::default(),
                p,
            );
            let mut build_homes: Vec<String> = options
                .iter()
                .filter_map(|o| match o.command {
                    crate::order::AdjustCommand::Build { region, .. } => {
                        Some(map.province(region.province).name.to_ascii_uppercase())
                    }
                    _ => None,
                })
                .collect();
            build_homes.sort();
            build_homes.dedup();
            builds.insert(
                name.clone(),
                BuildInfo {
                    count,
                    homes: build_homes,
                },
            );
        }
    }
    MilaState {
        name: state.phase.to_string(),
        units,
        centers,
        homes,
        retreats,
        builds,
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ImportError {
    #[error("unknown map {0}")]
    UnknownMap(String),
    #[error("unknown power {0}")]
    UnknownPower(String),
    #[error("bad phase name {0}")]
    BadPhase(String),
    #[error("bad unit {0}")]
    BadUnit(String),
    #[error("bad province {0}")]
    BadProvince(String),
}

/// Rebuild a state from MILA layout. Dislodged units (`*A PAR`) are restored without their
/// attacker origin, so retreat restrictions are approximated for imported games.
pub fn state_from_mila(map: &Map, s: &MilaState) -> Result<GameState, ImportError> {
    let phase = Phase::parse(&s.name).ok_or_else(|| ImportError::BadPhase(s.name.clone()))?;
    let mut state = GameState::from_position(phase, Default::default());
    for (power, list) in &s.units {
        let p = find_power(map, power).ok_or_else(|| ImportError::UnknownPower(power.clone()))?;
        for u in list {
            let (dislodged, text) = match u.strip_prefix('*') {
                Some(t) => (true, t),
                None => (false, u.as_str()),
            };
            let unit = parse_unit(map, p, text)?;
            if dislodged {
                state.dislodged.push(crate::state::Dislodged {
                    unit,
                    attacker_from: unit.province(),
                    by_convoy: true,
                });
            } else {
                state.position.add_unit(unit);
            }
        }
    }
    for (power, list) in &s.centers {
        let p = find_power(map, power).ok_or_else(|| ImportError::UnknownPower(power.clone()))?;
        for c in list {
            let id = map
                .find_province(c)
                .ok_or_else(|| ImportError::BadProvince(c.clone()))?;
            state.position.owners.insert(id, p);
        }
    }
    Ok(state)
}

fn parse_unit(map: &Map, power: Power, text: &str) -> Result<Unit, ImportError> {
    let mut it = text.split_whitespace();
    let kind = match it.next() {
        Some("A") => UnitKind::Army,
        Some("F") => UnitKind::Fleet,
        _ => return Err(ImportError::BadUnit(text.to_string())),
    };
    let region = it
        .next()
        .and_then(|r| map.parse_region(r))
        .ok_or_else(|| ImportError::BadUnit(text.to_string()))?;
    Ok(Unit {
        power,
        kind,
        region,
    })
}

fn result_codes(outcome: &OrderOutcome) -> Vec<String> {
    let code = match outcome {
        OrderOutcome::Illegal {
            dislodged_by: Some(_),
            ..
        } => vec!["void", "dislodged"],
        OrderOutcome::Illegal { .. } => vec!["void"],
        OrderOutcome::Hold(HoldOutcome::Holds) => vec![],
        OrderOutcome::Hold(HoldOutcome::Dislodged { .. }) => vec!["dislodged"],
        OrderOutcome::Move(MoveOutcome::Succeeds) => vec![],
        OrderOutcome::Move(MoveOutcome::NoPath) => vec!["no convoy"],
        OrderOutcome::Move(_) => vec!["bounce"],
        OrderOutcome::Support(SupportOutcome::Succeeds) => vec![],
        OrderOutcome::Support(SupportOutcome::Cut { .. }) => vec!["cut"],
        OrderOutcome::Support(SupportOutcome::Dislodged { .. }) => vec!["cut", "dislodged"],
        OrderOutcome::Support(SupportOutcome::Void) => vec!["void"],
        OrderOutcome::Convoy(ConvoyOutcome::Succeeds) => vec![],
        OrderOutcome::Convoy(ConvoyOutcome::Dislodged { .. }) => vec!["dislodged"],
        OrderOutcome::Convoy(ConvoyOutcome::Paradox) => vec!["void"],
        OrderOutcome::Convoy(ConvoyOutcome::Void) => vec!["void"],
    };
    code.into_iter().map(String::from).collect()
}

fn phase_to_mila(map: &Map, record: &PhaseRecord) -> MilaPhase {
    let state = state_to_mila(map, &record.state);
    let pos = &record.state.position;
    let mut orders: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut results: BTreeMap<String, Vec<String>> = BTreeMap::new();
    match &record.result {
        PhaseResult::Movement(r) => {
            for (o, out) in r.orders.iter().zip(&r.outcomes) {
                orders
                    .entry(power_name(map, o.power))
                    .or_default()
                    .push(order_text(map, pos, o));
                if let Some(u) = pos.unit_at(o.unit) {
                    results.insert(unit_text(map, u), result_codes(out));
                }
            }
        }
        PhaseResult::Retreat(r) => {
            for (o, out) in r.orders.iter().zip(&r.outcomes) {
                orders
                    .entry(power_name(map, o.power))
                    .or_default()
                    .push(retreat_text(map, pos, o));
                let unit = record
                    .state
                    .dislodged
                    .iter()
                    .find(|d| d.unit.province() == o.unit)
                    .map(|d| d.unit);
                if let Some(u) = unit {
                    let codes = match out {
                        RetreatOutcome::Succeeds => vec![],
                        RetreatOutcome::Bounced { .. } => {
                            vec!["bounce".to_string(), "disband".to_string()]
                        }
                        _ => vec!["disband".to_string()],
                    };
                    results.insert(unit_text(map, &u), codes);
                }
            }
        }
        PhaseResult::Adjustment(r) => {
            for (o, out) in r.orders.iter().zip(&r.outcomes) {
                let text = adjust_text(map, pos, o);
                orders
                    .entry(power_name(map, o.power))
                    .or_default()
                    .push(text.clone());
                let codes = match out {
                    crate::outcome::AdjustOutcome::Succeeds => vec![],
                    _ => vec!["void".to_string()],
                };
                results.insert(text, codes);
            }
            for u in &r.civil_disorder {
                results.insert(unit_text(map, u), vec!["disband".to_string()]);
            }
        }
    }
    for p in map.power_ids() {
        orders.entry(power_name(map, p)).or_default();
    }
    MilaPhase {
        name: record.state.phase.to_string(),
        state,
        orders,
        results,
        messages: Vec::new(),
    }
}

impl Game {
    /// Export the whole game, including the current (unplayed) phase, in MILA layout.
    pub fn to_saved(&self, id: &str) -> SavedGame {
        let map = self.map();
        let mut phases: Vec<MilaPhase> =
            self.history.iter().map(|r| phase_to_mila(map, r)).collect();
        let current = MilaPhase {
            name: if self.is_finished() {
                "COMPLETED".to_string()
            } else {
                self.state.phase.to_string()
            },
            state: state_to_mila(map, &self.state),
            ..Default::default()
        };
        phases.push(current);
        SavedGame {
            id: id.to_string(),
            map: map.name.clone(),
            rules: vec![format!("{:?}", self.rulebook.edition)],
            phases,
        }
    }

    /// Replay a saved game through the engine. Orders are re-parsed and re-adjudicated, so the
    /// result is only accepted when the engine reproduces every recorded state.
    pub fn from_saved(
        saved: &SavedGame,
        rulebook: crate::rulebook::Rulebook,
    ) -> Result<Game, ReplayError> {
        let map =
            Map::by_name(&saved.map).ok_or_else(|| ImportError::UnknownMap(saved.map.clone()))?;
        let first = saved.phases.first().ok_or(ReplayError::Empty)?;
        let start = state_from_mila(map, &first.state)?;
        let mut game = Game::from_state(map, rulebook, start);
        for (i, phase) in saved.phases.iter().enumerate() {
            if phase.name == "COMPLETED" || i + 1 == saved.phases.len() {
                break;
            }
            let mut typed: Vec<AnyOrder> = Vec::new();
            for (power, list) in &phase.orders {
                let p = find_power(map, power)
                    .ok_or_else(|| ImportError::UnknownPower(power.clone()))?;
                for text in list {
                    let parsed = crate::parse::parse(map, text)
                        .map_err(|e| ReplayError::Order(text.clone(), e.to_string()))?;
                    let order = match game.phase().kind {
                        PhaseKind::Movement => parsed.to_movement(Some(p)).map(AnyOrder::Movement),
                        PhaseKind::Retreat => parsed.to_retreat(Some(p)).map(AnyOrder::Retreat),
                        PhaseKind::Adjustment => {
                            parsed.to_adjustment(Some(p)).map(AnyOrder::Adjustment)
                        }
                    }
                    .map_err(|e| ReplayError::Order(text.clone(), e.to_string()))?;
                    typed.push(order);
                }
            }
            game.process(&typed).map_err(|_| ReplayError::Finished)?;
            let expected = &saved.phases[i + 1].state;
            let got = state_to_mila(map, &game.state);
            if got.units != expected.units || got.centers != expected.centers {
                return Err(ReplayError::Diverged {
                    phase: phase.name.clone(),
                });
            }
        }
        Ok(game)
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ReplayError {
    #[error(transparent)]
    Import(#[from] ImportError),
    #[error("saved game has no phases")]
    Empty,
    #[error("cannot parse order {0}: {1}")]
    Order(String, String),
    #[error("game already finished")]
    Finished,
    #[error("replay diverged from the recorded state after {phase}")]
    Diverged { phase: String },
}

/// Province name helper used by hosts.
pub fn province_code(map: &Map, p: ProvinceId) -> String {
    map.province(p).name.to_ascii_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse;
    use crate::rulebook::Rulebook;

    #[test]
    fn round_trip_through_mila_format() {
        let map = Map::standard();
        let mut g = Game::new(map, Rulebook::default());
        let o = |l: &[&str]| -> Vec<crate::order::Order> {
            l.iter()
                .map(|s| parse(map, s).unwrap().to_movement(None).unwrap())
                .collect()
        };
        g.process_movement(&o(&[
            "FRA: A PAR - BUR",
            "GER: A MUN - BUR",
            "ENG: F LON - NTH",
            "RUS: F SEV - BLA",
            "TUR: F ANK - BLA",
        ]));
        g.process_movement(&o(&[
            "ENG: F NTH - NWY",
            "RUS: A WAR - GAL",
            "AUS: A BUD - GAL",
        ]));
        let saved = g.to_saved("test");
        assert_eq!(saved.phases.len(), 3);
        assert_eq!(saved.phases[0].name, "S1901M");
        assert_eq!(saved.phases[1].state.units["FRANCE"].len(), 3);
        assert!(saved.phases[0].results["A PAR"].contains(&"bounce".to_string()));
        let json = serde_json::to_string(&saved).unwrap();
        let back: SavedGame = serde_json::from_str(&json).unwrap();
        let replayed = Game::from_saved(&back, Rulebook::default()).unwrap();
        assert_eq!(replayed.state, g.state);
        assert_eq!(replayed.history.len(), 2);
    }
}
