//! MILA / Cicero compatible saved game format.
//!
//! The shape follows `diplomacy.utils.export.to_saved_game_format` so that every
//! published AI Diplomacy harness and visualiser can read Cabal games. Powers are
//! named with their full upper case names (`FRANCE`), units as `A PAR` / `F STP/NC`,
//! dislodged units carry a `*` prefix in retreat phases, and results use the
//! MILA vocabulary (`bounce`, `cut`, `void`, `dislodged`, `no convoy`, `disband`).
//!
//! Cabal adds two optional `cabal` blocks that other readers ignore:
//!
//! - on the saved game ([`CabalMeta`]): the engine version, the full rulebook,
//!   the final outcome and the pledges, so a file says how to reproduce itself;
//! - on a retreat-phase state ([`StateExtras`]): where each dislodged unit was
//!   attacked from and which provinces saw a standoff, so the state is lossless.
//!
//! Three ways to load a saved game, from strictest to most trusting:
//!
//! - [`Game::verify_saved`](crate::verify) replays it and reports every difference;
//! - [`Game::from_saved`] replays it and fails if the board ever differs;
//! - [`Game::resume`] and [`Game::from_snapshot`](crate::snapshot) adjudicate
//!   nothing: the record is trusted, so an engine upgrade cannot break a game.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::game::{Game, PhaseRecord, PhaseResult, Status};
use crate::geo::{Map, Power, ProvinceId, Region, UnitKind};
use crate::order::{AnyOrder, Unit};
use crate::outcome::{
    ConvoyOutcome, HoldOutcome, MoveOutcome, OrderOutcome, RetreatOutcome, SupportOutcome,
};
use crate::pledge::Receipt;
use crate::rulebook::Rulebook;
use crate::state::{Dislodged, GameState, Phase, PhaseKind};
use crate::text::{adjust_text, order_text, retreat_text_in, unit_text};

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct BuildInfo {
    pub count: i32,
    pub homes: Vec<String>,
}

/// A dislodged unit and what restricts its retreat.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct DislodgedRecord {
    /// `A MUN`
    pub unit: String,
    /// Province the successful attacker came from (`BUR`).
    pub attacker_from: String,
    /// The attacker arrived by convoy, so its origin is open to the retreat.
    #[serde(default)]
    pub by_convoy: bool,
}

/// Cabal's lossless additions to a MILA state. Present only when there is
/// something to say, which in a game is exactly the retreat phases.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct StateExtras {
    #[serde(default)]
    pub dislodged: Vec<DislodgedRecord>,
    /// Provinces left vacant by a standoff in the preceding movement phase.
    #[serde(default)]
    pub standoffs: Vec<String>,
    /// The two lists were rebuilt from a record that had only the retreat
    /// options (see [`state_from_mila`]). They reproduce those options; they
    /// are not a record of who attacked from where.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub inferred: bool,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct MilaState {
    pub name: String,
    pub units: BTreeMap<String, Vec<String>>,
    pub centers: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub homes: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub retreats: BTreeMap<String, BTreeMap<String, Vec<String>>>,
    #[serde(default)]
    pub builds: BTreeMap<String, BuildInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cabal: Option<StateExtras>,
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
    #[serde(default)]
    pub orders: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub results: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub messages: Vec<MilaMessage>,
}

/// How a recorded game ended.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum SavedOutcome {
    /// Still being played.
    #[default]
    Active,
    Solo {
        winner: String,
    },
    /// Ended by agreement among `members`.
    Draw {
        members: Vec<String>,
    },
    /// A kind of ending this engine does not know, written by a newer one.
    /// Read as if no outcome had been recorded: the board and a final
    /// `COMPLETED` phase decide. Never written by this engine.
    #[serde(other)]
    Unknown,
}

/// A pledge as recorded in a saved game. Sealed pledges are recorded once revealed.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct SavedPledge {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    /// Phase the pledge binds (`S1901M`).
    pub phase: String,
    pub pledger: String,
    /// A power name, or `ALL`.
    pub audience: String,
    #[serde(default)]
    pub sealed: bool,
    /// Canonical order text.
    pub orders: Vec<String>,
    /// The seal: BLAKE3 over the canonical orders and the nonce, hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commitment: Option<String>,
    /// Hex nonce, so anyone holding the file can check that the seal opens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    /// `kept`, `broken` or `void`; absent until the phase is adjudicated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Receipt>,
}

/// An order that was sent for a phase and set aside before adjudication: text
/// that could not be read, an order for a unit the sender does not have, the
/// wrong kind of order for the phase. It had no effect on the board and is
/// kept so the record shows everything that was asked for.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct SavedRejection {
    pub power: String,
    /// The text exactly as submitted.
    pub input: String,
    /// A stable code such as `unparseable` or `foreign_unit`.
    pub code: String,
    /// One plain-English sentence.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
}

/// What Cabal records about a game beyond the MILA layout.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct CabalMeta {
    /// Version of the engine that started the record.
    pub engine: String,
    /// Every rule setting the game was played under.
    pub rulebook: Rulebook,
    pub outcome: SavedOutcome,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pledges: Vec<SavedPledge>,
    /// Orders set aside before adjudication, by the phase they were sent for.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub rejected: BTreeMap<String, Vec<SavedRejection>>,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct SavedGame {
    pub id: String,
    pub map: String,
    #[serde(default)]
    pub rules: Vec<String>,
    pub phases: Vec<MilaPhase>,
    /// Absent in files written by other tools and by Cabal before 0.1.0 recorded it.
    /// A `cabal` key holding something else (the server's replay endpoint puts its
    /// own summary there) is read as absent rather than refused.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "own_meta_or_none"
    )]
    pub cabal: Option<CabalMeta>,
}

/// `cabal` on a saved game is only this engine's record when it names the
/// engine and the rulebook. Hosts attach their own data under the same key,
/// and a file must not become unreadable because of an annotation the replay
/// does not need, so anything else is read as absent: a block that is not an
/// object, one without both keys, or one whose `rulebook` is not a rulebook.
///
/// The block is looked at before it is given a shape. A host field that
/// shares a name with one of the engine's but not its layout (a pledge with a
/// receipt this engine has never heard of, an outcome written as a string)
/// therefore cannot fail the file.
///
/// The engine's own block is read just as forgivingly, because a game has to
/// keep loading after a deploy is rolled back to an older engine: an outcome
/// kind this engine does not know becomes [`SavedOutcome::Unknown`], and a
/// pledge it cannot read is left out.
fn own_meta_or_none<'de, D>(deserializer: D) -> Result<Option<CabalMeta>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde_json::value::RawValue;

    // The block is kept as text and each part is read on its own, so one part
    // in an unexpected shape decides only its own fate.
    #[derive(Deserialize)]
    struct Parts<'a> {
        #[serde(borrow)]
        engine: Option<&'a RawValue>,
        #[serde(borrow)]
        rulebook: Option<&'a RawValue>,
        #[serde(borrow)]
        outcome: Option<&'a RawValue>,
        #[serde(borrow)]
        pledges: Option<&'a RawValue>,
        #[serde(borrow)]
        rejected: Option<&'a RawValue>,
    }
    fn read<'a, T: Deserialize<'a>>(raw: Option<&'a RawValue>) -> Option<T> {
        serde_json::from_str(raw?.get()).ok()
    }

    let block = Box::<RawValue>::deserialize(deserializer)?;
    let Ok(parts) = serde_json::from_str::<Parts>(block.get()) else {
        return Ok(None); // not an object
    };
    let (Some(engine), Some(rulebook)) = (read::<String>(parts.engine), read(parts.rulebook))
    else {
        return Ok(None);
    };
    let outcome = match parts.outcome {
        None => SavedOutcome::default(),
        some => read(some).unwrap_or(SavedOutcome::Unknown),
    };
    let pledges = read::<Vec<&RawValue>>(parts.pledges)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| read(Some(p)))
        .collect();
    Ok(Some(CabalMeta {
        engine,
        rulebook,
        outcome,
        pledges,
        rejected: read(parts.rejected).unwrap_or_default(),
    }))
}

pub(crate) fn power_name(map: &Map, p: Power) -> String {
    map.power(p).name.to_ascii_uppercase()
}

fn find_power(map: &Map, name: &str) -> Option<Power> {
    map.find_power(name)
}

/// Serialise a state in MILA layout under the default rulebook. Build sites
/// depend on the rulebook, so prefer [`state_to_mila_with`] when the game's
/// rulebook is at hand.
pub fn state_to_mila(map: &Map, state: &GameState) -> MilaState {
    state_to_mila_with(map, state, Rulebook::default())
}

/// Serialise a state in MILA layout, with build sites as `rulebook` allows them.
pub fn state_to_mila_with(map: &Map, state: &GameState, rulebook: Rulebook) -> MilaState {
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
            let (count, options) =
                crate::legal::legal_adjustments(map, &state.position, rulebook, p);
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
    let cabal = if state.dislodged.is_empty() && state.standoffs.is_empty() {
        None
    } else {
        Some(StateExtras {
            dislodged: state
                .dislodged
                .iter()
                .map(|d| DislodgedRecord {
                    unit: unit_text(map, &d.unit),
                    attacker_from: province_code(map, d.attacker_from),
                    by_convoy: d.by_convoy,
                })
                .collect(),
            standoffs: state
                .standoffs
                .iter()
                .map(|&p| province_code(map, p))
                .collect(),
            inferred: state.retreats_inferred,
        })
    };
    MilaState {
        name: state.phase.to_string(),
        units,
        centers,
        homes,
        retreats,
        builds,
        cabal,
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

/// Rebuild a state from MILA layout.
///
/// A state written by Cabal carries [`StateExtras`] and comes back exactly. For a
/// retreat-phase state without them (another tool's file, or one that crossed a
/// boundary that strips unknown keys), the restrictions are rebuilt from the
/// recorded `retreats`: whatever a dislodged unit could otherwise reach but is
/// not offered is closed again, as a standoff when it is closed to every unit
/// that borders it and as the attacker's origin otherwise. The legal retreats
/// of the result therefore match the record. With neither, a dislodged unit may
/// retreat to any vacant neighbour.
///
/// A state rebuilt that way says so ([`GameState::retreats_inferred`]) and is
/// written back with `inferred: true`, so a guess about why a province was
/// closed never becomes part of a record as if it had been observed.
pub fn state_from_mila(map: &Map, s: &MilaState) -> Result<GameState, ImportError> {
    let phase = Phase::parse(&s.name).ok_or_else(|| ImportError::BadPhase(s.name.clone()))?;
    let mut state = GameState::from_position(phase, Default::default());
    let mut dislodged: Vec<(String, Unit)> = Vec::new();
    for (power, list) in &s.units {
        let p = find_power(map, power).ok_or_else(|| ImportError::UnknownPower(power.clone()))?;
        for u in list {
            match u.strip_prefix('*') {
                // Only a retreat phase has dislodged units: anywhere else the mark would load a
                // unit the export never writes back.
                Some(_) if phase.kind != PhaseKind::Retreat => {
                    return Err(ImportError::BadUnit(u.clone()));
                }
                Some(text) => dislodged.push((power.clone(), parse_unit(map, p, text)?)),
                None => state.position.add_unit(parse_unit(map, p, u)?),
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
    let province = |name: &str| {
        map.parse_region(name)
            .map(|r| r.province)
            .ok_or_else(|| ImportError::BadProvince(name.to_string()))
    };
    // A unit named in a record, by its province: `A MUN` and `F STP/SC` both work.
    let unit_province = |text: &str| {
        text.split_whitespace()
            .nth(1)
            .and_then(|r| map.parse_region(r))
            .map(|r| r.province)
    };
    match &s.cabal {
        Some(extras) => {
            for (_, unit) in &dislodged {
                let record = extras
                    .dislodged
                    .iter()
                    .find(|d| unit_province(&d.unit) == Some(unit.province()));
                state.dislodged.push(match record {
                    Some(d) => Dislodged {
                        unit: *unit,
                        attacker_from: province(&d.attacker_from)?,
                        by_convoy: d.by_convoy,
                    },
                    None => unrestricted(*unit),
                });
            }
            for name in &extras.standoffs {
                state.standoffs.insert(province(name)?);
            }
            state.retreats_inferred = extras.inferred;
        }
        None => {
            state.retreats_inferred = !dislodged.is_empty();
            // candidate and recorded destinations per dislodged unit
            let mut known: Vec<(usize, BTreeSet<ProvinceId>, BTreeSet<ProvinceId>)> = Vec::new();
            for (i, (power, unit)) in dislodged.iter().enumerate() {
                state.dislodged.push(unrestricted(*unit));
                let recorded = s.retreats.get(power).and_then(|m| {
                    m.iter()
                        .find(|(k, _)| unit_province(k) == Some(unit.province()))
                        .map(|(_, v)| v)
                });
                let Some(recorded) = recorded else { continue };
                let candidates: BTreeSet<ProvinceId> = map
                    .reachable(unit.region, unit.kind)
                    .map(|r| r.province)
                    .filter(|&p| state.position.unit_at(p).is_none())
                    .collect();
                let mut allowed = BTreeSet::new();
                for name in recorded {
                    allowed.insert(province(name)?);
                }
                known.push((i, candidates, allowed));
            }
            let closed: BTreeSet<ProvinceId> = known
                .iter()
                .flat_map(|(_, c, a)| c.difference(a).copied().collect::<Vec<_>>())
                .collect();
            for p in closed {
                let closed_to_all = known
                    .iter()
                    .filter(|(_, c, _)| c.contains(&p))
                    .all(|(_, _, a)| !a.contains(&p));
                if closed_to_all {
                    state.standoffs.insert(p);
                } else {
                    for (i, c, a) in &known {
                        if c.contains(&p) && !a.contains(&p) {
                            state.dislodged[*i].attacker_from = p;
                            state.dislodged[*i].by_convoy = false;
                        }
                    }
                }
            }
        }
    }
    // the engine lists dislodged units in board order, whatever order the powers come in
    state.dislodged.sort_by_key(|d| d.unit.region);
    Ok(state)
}

/// A dislodged unit with no known restriction on where it may retreat.
fn unrestricted(unit: Unit) -> Dislodged {
    Dislodged {
        unit,
        attacker_from: unit.province(),
        by_convoy: true,
    }
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

fn retreat_result_codes(outcome: &RetreatOutcome) -> Vec<String> {
    match outcome {
        RetreatOutcome::Succeeds => vec![],
        RetreatOutcome::Illegal { .. } => vec!["void".to_string()],
        RetreatOutcome::Bounced { .. } => {
            vec!["bounce".to_string(), "disband".to_string()]
        }
        RetreatOutcome::Disbanded => vec!["disband".to_string()],
    }
}

fn adjustment_result_codes(outcome: &crate::outcome::AdjustOutcome) -> Vec<String> {
    match outcome {
        // The MILA vocabulary uses the empty string to mark a successful
        // adjustment (including a build or voluntary disband).
        crate::outcome::AdjustOutcome::Succeeds => vec![String::new()],
        crate::outcome::AdjustOutcome::Illegal { .. } => vec!["void".to_string()],
    }
}

pub(crate) fn phase_to_mila(map: &Map, rulebook: Rulebook, record: &PhaseRecord) -> MilaPhase {
    let state = state_to_mila_with(map, &record.state, rulebook);
    let pos = &record.state.position;
    let mut orders: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut results: BTreeMap<String, Vec<String>> = BTreeMap::new();
    match &record.result {
        PhaseResult::Movement(r) => {
            // What was asked for and never took effect is recorded as it was
            // submitted: an order thrown out as illegal, every line of a
            // duplicate, an order for a rival's unit or for an empty province.
            // Writing the hold the unit fell back to instead would make the
            // record say something that was never ordered, and a replay of it
            // could not reach the same ruling.
            let thrown_out = |province: ProvinceId| {
                r.outcome_at(province)
                    .is_none_or(|out| matches!(out, OrderOutcome::Illegal { .. }))
            };
            for any in &record.orders {
                let AnyOrder::Movement(o) = any else { continue };
                let owner = pos.unit_at(o.unit).map(|u| u.power);
                if owner != Some(o.power) || thrown_out(o.unit) {
                    orders
                        .entry(power_name(map, o.power))
                        .or_default()
                        .push(order_text(map, pos, o));
                }
            }
            for (o, out) in r.orders.iter().zip(&r.outcomes) {
                if !matches!(out, OrderOutcome::Illegal { .. }) {
                    orders
                        .entry(power_name(map, o.power))
                        .or_default()
                        .push(order_text(map, pos, o));
                }
                if let Some(u) = pos.unit_at(o.unit) {
                    let mut codes = result_codes(out);
                    // a move that failed and whose unit was then dislodged is both
                    let dislodged = r.dislodged.iter().any(|d| d.unit.province() == o.unit);
                    if dislodged && !codes.iter().any(|c| c == "dislodged") {
                        codes.push("dislodged".to_string());
                    }
                    results.insert(unit_text(map, u), codes);
                }
            }
        }
        PhaseResult::Retreat(r) => {
            // As for movement: what never took effect is recorded as submitted.
            // That is an order for a rival's dislodged unit (ignored) and every
            // line when the owner ordered a unit twice (it disbands).
            let owner_of = |province: ProvinceId| {
                record
                    .state
                    .dislodged
                    .iter()
                    .find(|d| d.unit.province() == province)
                    .map(|d| d.unit.power)
            };
            let own_orders = |province: ProvinceId| {
                let owner = owner_of(province);
                record
                    .orders
                    .iter()
                    .filter(|any| {
                        matches!(any, AnyOrder::Retreat(o)
                            if o.unit == province && Some(o.power) == owner)
                    })
                    .count()
            };
            for any in &record.orders {
                let AnyOrder::Retreat(o) = any else { continue };
                let Some(owner) = owner_of(o.unit) else {
                    continue; // not dislodged: the resolver lists it as a stray
                };
                if owner != o.power || own_orders(o.unit) > 1 {
                    orders
                        .entry(power_name(map, o.power))
                        .or_default()
                        .push(retreat_text_in(map, &record.state, o));
                }
            }
            for (o, out) in r.orders.iter().zip(&r.outcomes) {
                if own_orders(o.unit) <= 1 {
                    orders
                        .entry(power_name(map, o.power))
                        .or_default()
                        .push(retreat_text_in(map, &record.state, o));
                }
                let unit = record
                    .state
                    .dislodged
                    .iter()
                    .find(|d| d.unit.province() == o.unit)
                    .map(|d| d.unit);
                if let Some(u) = unit {
                    let codes = retreat_result_codes(out);
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
                // MILA keys adjustment results by the unit for builds and
                // disbands (the order without its verb) and by `WAIVE` for waives.
                let key = text
                    .strip_suffix(" B")
                    .or_else(|| text.strip_suffix(" D"))
                    .unwrap_or(&text)
                    .to_string();
                // Several orders can share a key (every waive does, and so do
                // two orders for one site). The entry then carries each distinct
                // code once, sorted, so it does not depend on the order the
                // orders arrived in and a replay writes the same entry.
                let entry = results.entry(key).or_default();
                for code in adjustment_result_codes(out) {
                    if !entry.contains(&code) {
                        entry.push(code);
                    }
                }
                entry.sort();
            }
            // MILA turns civil disorder into ordinary disband orders, so the
            // forced removals succeed with the empty OK code.
            for u in &r.civil_disorder {
                results.insert(unit_text(map, u), vec![String::new()]);
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

/// The orders of one recorded phase: those that parse, and `(order text,
/// reason)` for those that do not.
pub(crate) type RecordedOrders = (Vec<AnyOrder>, Vec<(String, String)>);

/// Parse the recorded orders of one phase.
pub(crate) fn recorded_orders(
    map: &Map,
    kind: PhaseKind,
    orders: &BTreeMap<String, Vec<String>>,
) -> Result<RecordedOrders, ImportError> {
    let mut typed = Vec::new();
    let mut bad = Vec::new();
    for (power, list) in orders {
        let p = find_power(map, power).ok_or_else(|| ImportError::UnknownPower(power.clone()))?;
        for text in list {
            let order = crate::parse::parse(map, text).and_then(|parsed| match kind {
                PhaseKind::Movement => parsed.to_movement(Some(p)).map(AnyOrder::Movement),
                PhaseKind::Retreat => parsed.to_retreat(Some(p)).map(AnyOrder::Retreat),
                PhaseKind::Adjustment => parsed.to_adjustment(Some(p)).map(AnyOrder::Adjustment),
            });
            match order {
                Ok(o) => typed.push(o),
                Err(e) => bad.push((text.clone(), e.to_string())),
            }
        }
    }
    Ok((typed, bad))
}

/// The name an edition goes by in [`Rulebook::by_name`] and in `SavedGame.rules`.
pub fn edition_name(rulebook: Rulebook) -> &'static str {
    use crate::rulebook::Edition;
    match rulebook.edition {
        Edition::E1971 => "1971",
        Edition::E1982 => "1982",
        Edition::E2023 => "2023",
        Edition::Dptg => "dptg",
    }
}

/// The rulebook a saved game was played under: the recorded one, else an edition
/// named in `rules` (Cabal once wrote `E2023` there), else `fallback`.
pub fn saved_rulebook(saved: &SavedGame, fallback: Rulebook) -> Rulebook {
    if let Some(meta) = &saved.cabal {
        return meta.rulebook;
    }
    saved
        .rules
        .iter()
        .find_map(|r| Rulebook::by_name(r.trim_start_matches(['E', 'e'])))
        .unwrap_or(fallback)
}

fn powers_named(map: &Map, names: &[String]) -> Result<Vec<Power>, ImportError> {
    names
        .iter()
        .map(|n| find_power(map, n).ok_or_else(|| ImportError::UnknownPower(n.clone())))
        .collect()
}

impl Game {
    /// How the game stands, in the saved-game vocabulary.
    pub fn saved_outcome(&self) -> SavedOutcome {
        let map = self.map();
        match self.status {
            Status::Active => SavedOutcome::Active,
            Status::Solo { winner } => SavedOutcome::Solo {
                winner: power_name(map, winner),
            },
            Status::Draw => SavedOutcome::Draw {
                members: self
                    .draw_members
                    .iter()
                    .map(|&p| power_name(map, p))
                    .collect(),
            },
        }
    }

    /// Export the whole game, including the current (unplayed) phase, in MILA layout.
    pub fn to_saved(&self, id: &str) -> SavedGame {
        let map = self.map();
        let mut phases = self.archive.clone();
        for record in &self.history {
            let mut phase = phase_to_mila(map, self.rulebook, record);
            if let Some(messages) = self.press.get(&phase.name) {
                phase.messages = messages.clone();
            }
            phases.push(phase);
        }
        let state = state_to_mila_with(map, &self.state, self.rulebook);
        let current = MilaPhase {
            name: if self.is_finished() {
                "COMPLETED".to_string()
            } else {
                self.state.phase.to_string()
            },
            messages: self.press.get(&state.name).cloned().unwrap_or_default(),
            state,
            ..Default::default()
        };
        phases.push(current);
        SavedGame {
            id: id.to_string(),
            map: map.name.clone(),
            rules: vec![edition_name(self.rulebook).to_string()],
            phases,
            cabal: Some(CabalMeta {
                engine: self.recorded_by.clone(),
                rulebook: self.rulebook,
                outcome: self.saved_outcome(),
                pledges: self.pledges.clone(),
                rejected: self.rejected.clone(),
            }),
        }
    }

    /// Start a game at the first recorded state of `saved`, under its rulebook.
    pub(crate) fn begin_saved(saved: &SavedGame, fallback: Rulebook) -> Result<Game, ReplayError> {
        let map =
            Map::by_name(&saved.map).ok_or_else(|| ImportError::UnknownMap(saved.map.clone()))?;
        let first = saved.phases.first().ok_or(ReplayError::Empty)?;
        let start = state_from_mila(map, &first.state)?;
        let mut game = Game::from_state(map, saved_rulebook(saved, fallback), start);
        game.adopt_meta(saved);
        Ok(game)
    }

    /// Take over what a saved game records besides its phases.
    fn adopt_meta(&mut self, saved: &SavedGame) {
        if let Some(meta) = &saved.cabal {
            self.recorded_by = meta.engine.clone();
            self.pledges = meta.pledges.clone();
            self.rejected = meta.rejected.clone();
        }
    }

    /// Apply the recorded ending. A solo follows from the board, so only an
    /// agreed draw has to be taken from the record: from the `cabal` block, or
    /// from a final phase named `COMPLETED` in a file without one.
    pub(crate) fn adopt_outcome(&mut self, saved: &SavedGame) -> Result<(), ReplayError> {
        if self.status != Status::Active {
            return Ok(());
        }
        match saved.cabal.as_ref().map(|m| &m.outcome) {
            Some(SavedOutcome::Draw { members }) => {
                let members = powers_named(self.map(), members)?;
                self.declare_draw_among(&members);
            }
            Some(SavedOutcome::Active | SavedOutcome::Solo { .. }) => {}
            Some(SavedOutcome::Unknown) | None => {
                if saved.phases.last().is_some_and(|p| p.name == "COMPLETED") {
                    self.declare_draw();
                }
            }
        }
        Ok(())
    }

    /// Replay a saved game through the engine. Orders are re-parsed and
    /// re-adjudicated, and the result is only accepted when the engine reproduces
    /// the units and centres of every recorded state. The rulebook comes from the
    /// file when it records one; `rulebook` is the fallback for files that do not.
    ///
    /// Use [`Game::verify_saved`] for a full report of differences, and
    /// [`Game::resume`] to continue a trusted game without adjudicating its past.
    pub fn from_saved(saved: &SavedGame, rulebook: Rulebook) -> Result<Game, ReplayError> {
        let mut game = Game::begin_saved(saved, rulebook)?;
        let map = game.map();
        for (i, phase) in saved.phases.iter().enumerate() {
            if !phase.messages.is_empty() {
                game.press
                    .insert(phase.state.name.clone(), phase.messages.clone());
            }
            if phase.name == "COMPLETED" || i + 1 == saved.phases.len() {
                break;
            }
            let (typed, bad) = recorded_orders(map, game.phase().kind, &phase.orders)?;
            if let Some((text, reason)) = bad.into_iter().next() {
                return Err(ReplayError::Order(text, reason));
            }
            game.process(&typed).map_err(|_| ReplayError::Finished)?;
            let expected = &saved.phases[i + 1].state;
            let got = state_to_mila_with(map, &game.state, game.rulebook);
            if !same_holdings(&got.units, &expected.units)
                || !same_holdings(&got.centers, &expected.centers)
            {
                return Err(ReplayError::Diverged {
                    phase: phase.name.clone(),
                });
            }
        }
        game.adopt_outcome(saved)?;
        Ok(game)
    }

    /// Continue a saved game without adjudicating anything: the last recorded
    /// state becomes the current state and every earlier phase is kept verbatim
    /// in [`Game::archive`]. Because nothing is replayed, this cannot fail on a
    /// game recorded by an older engine whose rulings have since been corrected.
    ///
    /// The record is trusted, not checked; run [`Game::verify_saved`] for that.
    pub fn resume(saved: &SavedGame, rulebook: Rulebook) -> Result<Game, ReplayError> {
        let map =
            Map::by_name(&saved.map).ok_or_else(|| ImportError::UnknownMap(saved.map.clone()))?;
        let (last, earlier) = saved.phases.split_last().ok_or(ReplayError::Empty)?;
        let state = state_from_mila(map, &last.state)?;
        let mut game = Game::from_state(map, saved_rulebook(saved, rulebook), state);
        game.adopt_meta(saved);
        game.archive = earlier.to_vec();
        if !last.messages.is_empty() {
            game.press
                .insert(last.state.name.clone(), last.messages.clone());
        }
        game.adopt_recorded_status(
            saved.cabal.as_ref().map(|m| &m.outcome),
            last.name == "COMPLETED",
        )?;
        Ok(game)
    }

    /// Set the status from a record without replaying: the recorded outcome when
    /// there is one, otherwise what a `COMPLETED` final phase implies.
    pub(crate) fn adopt_recorded_status(
        &mut self,
        outcome: Option<&SavedOutcome>,
        completed: bool,
    ) -> Result<(), ReplayError> {
        let map = self.map();
        match outcome {
            Some(SavedOutcome::Active) => {}
            Some(SavedOutcome::Solo { winner }) => {
                let winner = find_power(map, winner)
                    .ok_or_else(|| ImportError::UnknownPower(winner.clone()))?;
                self.status = Status::Solo { winner };
            }
            Some(SavedOutcome::Draw { members }) => {
                let members = powers_named(map, members)?;
                self.declare_draw_among(&members);
            }
            Some(SavedOutcome::Unknown) | None if completed => match self.solo_winner() {
                Some(winner) => self.status = Status::Solo { winner },
                None => self.declare_draw(),
            },
            Some(SavedOutcome::Unknown) | None => {}
        }
        Ok(())
    }

    /// The record of adjudicated phase `index`, counting archived phases first.
    ///
    /// Archived phases keep only their MILA text, so their record is derived on
    /// demand by adjudicating that one phase from its recorded state. `None`
    /// when the index is out of range or an archived phase cannot be read.
    pub fn record_at(&self, index: usize) -> Option<std::borrow::Cow<'_, PhaseRecord>> {
        use std::borrow::Cow;
        if let Some(i) = index.checked_sub(self.archive.len()) {
            return self.history.get(i).map(Cow::Borrowed);
        }
        let phase = &self.archive[index];
        let map = self.map();
        let state = state_from_mila(map, &phase.state).ok()?;
        let (typed, _) = recorded_orders(map, state.phase.kind, &phase.orders).ok()?;
        let mut game = Game::from_state(map, self.rulebook, state);
        game.process(&typed).ok()?;
        game.history.pop().map(Cow::Owned)
    }

    /// The state that followed adjudicated phase `index`, as recorded.
    pub fn state_after(&self, index: usize) -> Option<GameState> {
        if index >= self.phase_count() {
            return None;
        }
        if index + 1 < self.archive.len() {
            return state_from_mila(self.map(), &self.archive[index + 1].state).ok();
        }
        let next = index + 1 - self.archive.len();
        Some(match self.history.get(next) {
            Some(record) => record.state.clone(),
            None => self.state.clone(),
        })
    }
}

/// Compare per-power unit or centre lists as sets. Other MILA writers (Cicero
/// among them) list a power's holdings in their own order and may omit powers
/// that hold nothing, neither of which is a divergence.
pub(crate) fn same_holdings(
    a: &BTreeMap<String, Vec<String>>,
    b: &BTreeMap<String, Vec<String>>,
) -> bool {
    let sorted = |m: &BTreeMap<String, Vec<String>>, k: &String| {
        let mut v = m.get(k).cloned().unwrap_or_default();
        v.sort();
        v
    };
    a.keys()
        .chain(b.keys())
        .all(|k| sorted(a, k) == sorted(b, k))
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
    #[error("unsupported snapshot format {0}")]
    SnapshotFormat(u32),
    #[error("the saved game is not the history of this snapshot: {0}")]
    SnapshotMismatch(String),
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
    use crate::state::Position;

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

    #[test]
    fn retreat_and_adjustment_results_use_mila_codes() {
        let map = Map::standard();
        let france = map.find_power("FRANCE").unwrap();
        let mut retreat_state = GameState::from_position(
            Phase::new(1901, crate::state::Season::Spring, PhaseKind::Retreat),
            Position::initial(map),
        );
        let paris = map.find_province("par").unwrap();
        let attacker = map.find_province("bur").unwrap();
        let unit = retreat_state.position.remove_unit_at(paris).unwrap();
        retreat_state.dislodged.push(crate::state::Dislodged {
            unit,
            attacker_from: attacker,
            by_convoy: false,
        });
        let mut retreat_game = Game::from_state(map, Rulebook::default(), retreat_state);
        let retreat = parse(map, "FRA: A PAR R BUR")
            .unwrap()
            .to_retreat(None)
            .unwrap();
        retreat_game.process_retreat(&[retreat]);
        let saved = retreat_game.to_saved("results");
        assert_eq!(saved.phases[0].results["A PAR"], vec!["void".to_string()]);

        // A successful build is encoded with MILA's empty-string OK result.
        let mut position = Position::initial(map);
        position
            .owners
            .insert(map.find_province("bel").unwrap(), france);
        position.remove_unit_at(map.find_province("mar").unwrap());
        let mut adjustment = Game::from_state(
            map,
            Rulebook::default(),
            GameState::from_position(
                Phase::new(1901, crate::state::Season::Winter, PhaseKind::Adjustment),
                position,
            ),
        );
        let build = parse(map, "FRANCE: A MAR B")
            .unwrap()
            .to_adjustment(None)
            .unwrap();
        adjustment.process_adjustment(&[build]);
        let saved = adjustment.to_saved("build");
        assert_eq!(saved.phases[0].results["A MAR"], vec!["".to_string()]);
        assert!(!saved.phases[0].results.contains_key("A MAR B"));
    }

    #[test]
    fn civil_disorder_removals_use_the_mila_ok_code() {
        let map = Map::standard();
        let mut position = Position::initial(map);
        // France keeps three units but loses Brest, so one unit must go.
        position.owners.remove(&map.find_province("bre").unwrap());
        let mut game = Game::from_state(
            map,
            Rulebook::default(),
            GameState::from_position(
                Phase::new(1901, crate::state::Season::Winter, PhaseKind::Adjustment),
                position,
            ),
        );
        game.process_adjustment(&[]);
        let saved = game.to_saved("disorder");
        let removed: Vec<_> = saved.phases[0]
            .results
            .iter()
            .filter(|(unit, _)| unit.starts_with("A ") || unit.starts_with("F "))
            .collect();
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].1, &vec![String::new()]);
    }

    #[test]
    fn retreat_and_adjustment_result_vocabulary_is_complete() {
        use crate::outcome::{AdjustIllegal, AdjustOutcome, RetreatIllegal};

        assert_eq!(
            retreat_result_codes(&RetreatOutcome::Succeeds),
            Vec::<String>::new()
        );
        assert_eq!(
            retreat_result_codes(&RetreatOutcome::Illegal {
                reason: RetreatIllegal::Occupied
            }),
            vec!["void"]
        );
        assert_eq!(
            retreat_result_codes(&RetreatOutcome::Bounced { with: vec![] }),
            vec!["bounce", "disband"]
        );
        assert_eq!(
            retreat_result_codes(&RetreatOutcome::Disbanded),
            vec!["disband"]
        );
        assert_eq!(adjustment_result_codes(&AdjustOutcome::Succeeds), vec![""]);
        assert_eq!(
            adjustment_result_codes(&AdjustOutcome::Illegal {
                reason: AdjustIllegal::NothingToDo
            }),
            vec!["void"]
        );
    }
}
