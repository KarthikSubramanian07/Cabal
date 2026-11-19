//! Order validation against the board: one verdict per submitted line.
//!
//! [`crate::parse`] only knows syntax, so `A PAR - MOS` parses. This module
//! asks the same question the resolvers ask (the movement check is
//! [`crate::order::normalise`] itself, retreats and adjustments are run through
//! their resolver), so a line is `legal` here exactly when adjudication would
//! not throw it out. Nothing is mutated, and a bad line never hides the
//! verdicts of the others.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::adjudicate::adjustment::resolve_adjustment;
use crate::adjudicate::retreat::resolve_retreat;
use crate::geo::{Map, Power, ProvinceId};
use crate::order::{AdjustCommand, AnyOrder, check, fleet_seas};
use crate::outcome::{AdjustOutcome, Illegal, RetreatOutcome};
use crate::parse::{ParseError, parse};
use crate::rulebook::Rulebook;
use crate::state::{GameState, PhaseKind};
use crate::text::{adjust_text, order_text, retreat_text_in, unit_text};

/// The verdict on one submitted order.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Verdict {
    /// The line exactly as submitted.
    pub input: String,
    /// Canonical text when the line parses as an order for this phase, legal or not.
    pub canonical: Option<String>,
    /// Would adjudication accept this order as written?
    pub legal: bool,
    /// `ok`, or why not. Lines that never reach the board: `unparseable`,
    /// `wrong_power`, `wrong_phase`. Otherwise the engine's own reason:
    /// `no_unit`, `foreign_unit`, `duplicate_order`, `move_to_self`,
    /// `unreachable`, `ambiguous_coast`, `support_self`, `support_unreachable`,
    /// `support_no_unit`, `convoy_not_at_sea`, `convoy_not_army`,
    /// `convoy_no_route` (movement); `not_dislodged`, `occupied`,
    /// `attacker_origin`, `standoff` (retreats); `nothing_to_do`,
    /// `allowance_used`, `not_home_center`, `not_owned`, `bad_terrain`
    /// (adjustments).
    pub code: String,
    /// One plain-English sentence.
    pub reason: String,
    /// The unit the order is for (`A PAR`), when there is one on the board.
    pub unit: Option<String>,
    /// The typed order, when the line parses for this phase.
    #[serde(skip)]
    pub order: Option<AnyOrder>,
}

impl Verdict {
    /// Does adjudication have a unit of the submitting power to pin this order
    /// on? Orders that do not are the ones a host should report as rejected
    /// rather than hand to the resolver.
    pub fn addresses_own_unit(&self) -> bool {
        self.order.is_some()
            && !matches!(
                self.code.as_str(),
                "no_unit" | "foreign_unit" | "not_dislodged"
            )
    }
}

fn sentence(clause: &str) -> String {
    let mut chars = clause.chars();
    match chars.next() {
        Some(first) => format!("{}{}.", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

fn rejected(input: &str, code: &str, reason: String) -> Verdict {
    Verdict {
        input: input.to_string(),
        canonical: None,
        legal: false,
        code: code.to_string(),
        reason,
        unit: None,
        order: None,
    }
}

fn parse_failure(input: &str, e: &ParseError) -> Verdict {
    match e {
        ParseError::NotInPhase(kind) => rejected(
            input,
            "wrong_phase",
            format!("A {kind} order cannot be given in this phase."),
        ),
        ParseError::Empty => rejected(input, "unparseable", "The order is empty.".into()),
        ParseError::UnknownProvince(word) => rejected(
            input,
            "unparseable",
            format!("The order could not be read: {word} is not a province."),
        ),
        ParseError::UnknownPower(word) => rejected(
            input,
            "unparseable",
            format!("The order could not be read: {word} is not a power."),
        ),
        ParseError::Incomplete => rejected(
            input,
            "unparseable",
            "The order could not be read: it stops before it is complete.".into(),
        ),
        // the token dump of the other errors is for developers, not players
        ParseError::Unexpected(_) | ParseError::MissingPower => rejected(
            input,
            "unparseable",
            "The order could not be read: write it like A PAR - BUR, A MAR S A PAR - BUR or F NTH C A LON - BEL.".into(),
        ),
    }
}

const LEGAL: &str = "The order is legal.";

/// Validate the orders `power` wants to submit for the current phase of
/// `state`. Verdicts come back in input order, one per line. Orders are judged
/// together where the rules say so: two orders for one unit are both
/// `duplicate_order`, and builds past the allowance are `allowance_used`.
pub fn validate_orders<S: AsRef<str>>(
    map: &Map,
    state: &GameState,
    rulebook: Rulebook,
    power: Power,
    texts: &[S],
) -> Vec<Verdict> {
    // syntax first; `None` marks a line that went no further
    let mut out: Vec<Verdict> = Vec::with_capacity(texts.len());
    let mut typed: Vec<Option<AnyOrder>> = Vec::with_capacity(texts.len());
    for text in texts {
        let text = text.as_ref();
        let parsed = match parse(map, text) {
            Ok(p) => p,
            Err(e) => {
                out.push(parse_failure(text, &e));
                typed.push(None);
                continue;
            }
        };
        // The power an order is filed under is the authority; a prefix naming
        // another power must never let one power order another's units.
        if let Some(named) = parsed.power.filter(|&named| named != power) {
            out.push(rejected(
                text,
                "wrong_power",
                format!(
                    "The order names {} but was submitted for {}.",
                    map.power(named).name,
                    map.power(power).name
                ),
            ));
            typed.push(None);
            continue;
        }
        let order = match state.phase.kind {
            PhaseKind::Movement => parsed.to_movement(Some(power)).map(AnyOrder::Movement),
            PhaseKind::Retreat => parsed.to_retreat(Some(power)).map(AnyOrder::Retreat),
            PhaseKind::Adjustment => parsed.to_adjustment(Some(power)).map(AnyOrder::Adjustment),
        };
        match order {
            Ok(o) => {
                out.push(Verdict {
                    input: text.to_string(),
                    canonical: None,
                    legal: true,
                    code: "ok".to_string(),
                    reason: LEGAL.to_string(),
                    unit: None,
                    order: Some(o),
                });
                typed.push(Some(o));
            }
            Err(e) => {
                out.push(parse_failure(text, &e));
                typed.push(None);
            }
        }
    }

    let fail = |v: &mut Verdict, code: &str, clause: &str| {
        v.legal = false;
        v.code = code.to_string();
        v.reason = sentence(clause);
    };
    let position = &state.position;

    // how many orders each unit received (DATC 4.D.3)
    let mut per_unit: HashMap<ProvinceId, usize> = HashMap::new();
    for o in typed.iter().flatten() {
        match o {
            AnyOrder::Movement(m) => *per_unit.entry(m.unit).or_default() += 1,
            AnyOrder::Retreat(r) => *per_unit.entry(r.unit).or_default() += 1,
            AnyOrder::Adjustment(_) => {}
        }
    }

    match state.phase.kind {
        PhaseKind::Movement => {
            let seas = fleet_seas(map, position);
            for (v, o) in out.iter_mut().zip(&typed) {
                let Some(AnyOrder::Movement(order)) = o else {
                    continue;
                };
                v.unit = position
                    .unit_at(order.unit)
                    .filter(|u| u.power == power)
                    .map(|u| unit_text(map, u));
                let verdict = check(map, position, &seas, *order);
                let written = verdict.as_ref().map_or(*order, |c| c.order);
                v.canonical = Some(order_text(map, position, &written));
                v.order = Some(AnyOrder::Movement(written));
                // as in the resolver, a unit with two orders has no order at all
                let reason = match verdict {
                    Err(Illegal::NoUnit) => Some(Illegal::NoUnit),
                    Err(Illegal::ForeignUnit) => Some(Illegal::ForeignUnit),
                    _ if per_unit[&order.unit] > 1 => Some(Illegal::DuplicateOrder),
                    other => other.err(),
                };
                if let Some(reason) = reason {
                    fail(v, reason.code(), reason.message());
                }
            }
        }
        PhaseKind::Retreat => {
            for (v, o) in out.iter_mut().zip(&typed) {
                let Some(AnyOrder::Retreat(order)) = o else {
                    continue;
                };
                v.canonical = Some(retreat_text_in(map, state, order));
                let Some(d) = state
                    .dislodged
                    .iter()
                    .find(|d| d.unit.province() == order.unit)
                else {
                    fail(v, "not_dislodged", "that unit was not dislodged");
                    continue;
                };
                if d.unit.power != power {
                    let r = Illegal::ForeignUnit;
                    fail(v, r.code(), r.message());
                    continue;
                }
                v.unit = Some(unit_text(map, &d.unit));
                if per_unit[&order.unit] > 1 {
                    let r = Illegal::DuplicateOrder;
                    fail(v, r.code(), r.message());
                    continue;
                }
                // alone, so the only failure left is an illegal destination
                let result = resolve_retreat(map, state, std::slice::from_ref(order));
                if let Some(RetreatOutcome::Illegal { reason }) = result.outcome_at(order.unit) {
                    fail(v, reason.code(), reason.message());
                }
            }
        }
        PhaseKind::Adjustment => {
            // builds and disbands use up an allowance, so judge them in order
            let orders: Vec<_> = typed
                .iter()
                .filter_map(|o| match o {
                    Some(AnyOrder::Adjustment(a)) => Some(*a),
                    _ => None,
                })
                .collect();
            let result = resolve_adjustment(map, position, rulebook, &orders);
            let mut outcomes = result.outcomes.iter();
            for (v, o) in out.iter_mut().zip(&typed) {
                let Some(AnyOrder::Adjustment(order)) = o else {
                    continue;
                };
                v.canonical = Some(adjust_text(map, position, order));
                if let AdjustCommand::Disband { unit } = order.command {
                    v.unit = position
                        .unit_at(unit)
                        .filter(|u| u.power == power)
                        .map(|u| unit_text(map, u));
                }
                if let Some(AdjustOutcome::Illegal { reason }) = outcomes.next() {
                    fail(v, reason.code(), reason.message());
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Position;

    fn france() -> (&'static Map, Power) {
        let map = Map::standard();
        (map, map.find_power("FRANCE").unwrap())
    }

    fn codes(v: &[Verdict]) -> Vec<&str> {
        v.iter().map(|v| v.code.as_str()).collect()
    }

    #[test]
    fn movement_orders_are_judged_against_the_board() {
        let (map, fra) = france();
        let state = GameState::initial(map);
        let v = validate_orders(
            map,
            &state,
            Rulebook::default(),
            fra,
            &[
                "A PAR - BUR",
                "a par - mos",
                "F BRE - PAR",
                "A MAR S A PAR - GAS",
                "A MUN H",
                "A BUR H",
                "complete garbage",
                "GER: A PAR H",
                "A PAR B",
            ],
        );
        assert_eq!(
            codes(&v),
            [
                "duplicate_order",
                "duplicate_order",
                "unreachable",
                "ok",
                "foreign_unit",
                "no_unit",
                "unparseable",
                "wrong_power",
                "wrong_phase",
            ]
        );
        assert_eq!(v[1].canonical.as_deref(), Some("A PAR - MOS"));
        assert_eq!(v[3].canonical.as_deref(), Some("A MAR S A PAR - GAS"));
        assert_eq!(v[3].unit.as_deref(), Some("A MAR"));
        assert!(v[3].legal);
        assert!(v.iter().filter(|v| v.code != "ok").all(|v| !v.legal));
        // an order for somebody else's unit names no unit of ours
        assert_eq!(v[4].unit, None);
        assert!(!v[4].addresses_own_unit());
        assert!(
            v[2].addresses_own_unit(),
            "an illegal move still has a unit"
        );
        assert!(v[6].canonical.is_none());
        for verdict in &v {
            assert!(verdict.reason.ends_with('.'), "{}", verdict.reason);
            assert!(!verdict.reason.contains("::"), "{}", verdict.reason);
        }
    }

    #[test]
    fn a_single_order_is_canonicalised() {
        let (map, _) = france();
        let rus = map.find_power("RUSSIA").unwrap();
        let state = GameState::initial(map);
        let v = validate_orders(
            map,
            &state,
            Rulebook::default(),
            rus,
            &["f stp - bot", "F SEV - BLA", "A WAR - GAL"],
        );
        assert!(v.iter().all(|v| v.legal), "{v:?}");
        assert_eq!(v[0].canonical.as_deref(), Some("F STP/SC - BOT"));
    }

    #[test]
    fn retreats_are_judged_against_the_retreat_restrictions() {
        let (map, fra) = france();
        let ger = map.find_power("GERMANY").unwrap();
        // France took Munich from Burgundy; Tyrolia is occupied and the Ruhr saw a standoff
        let mut state = GameState::initial(map);
        let id = |name: &str| map.find_province(name).unwrap();
        state.position.remove_unit_at(id("par"));
        let unit = state.position.remove_unit_at(id("mun")).unwrap();
        let army = crate::geo::UnitKind::Army;
        state
            .position
            .set_unit(fra, army, crate::geo::Region::land(id("mun")));
        let ita = map.find_power("ITALY").unwrap();
        state
            .position
            .set_unit(ita, army, crate::geo::Region::land(id("tyr")));
        state.dislodged.push(crate::state::Dislodged {
            unit,
            attacker_from: id("bur"),
            by_convoy: false,
        });
        state.standoffs.insert(id("ruh"));
        state.phase.kind = PhaseKind::Retreat;
        let v = validate_orders(
            map,
            &state,
            Rulebook::default(),
            ger,
            &["A MUN R BUR", "A MUN R RUH", "A MUN R KIE", "A MUN R PAR"],
        );
        // four orders for one unit: all duplicates, whatever else is wrong
        assert_eq!(codes(&v), ["duplicate_order"; 4]);
        let one =
            |text: &str| validate_orders(map, &state, Rulebook::default(), ger, &[text]).remove(0);
        assert_eq!(one("A MUN R BUR").code, "attacker_origin");
        assert_eq!(one("A MUN R RUH").code, "standoff");
        assert_eq!(one("A MUN R PAR").code, "unreachable");
        assert_eq!(one("A MUN R TYR").code, "occupied");
        assert_eq!(one("A BER R KIE").code, "not_dislodged");
        assert_eq!(one("A MUN S A BER").code, "wrong_phase");
        let ok = one("mun r boh");
        assert!(ok.legal);
        assert_eq!(ok.canonical.as_deref(), Some("A MUN R BOH"));
        assert_eq!(ok.unit.as_deref(), Some("A MUN"));
        assert!(one("A MUN D").legal);
        // France may not retreat Germany's unit
        let foreign = validate_orders(map, &state, Rulebook::default(), fra, &["A MUN R KIE"]);
        assert_eq!(foreign[0].code, "foreign_unit");
    }

    #[test]
    fn builds_use_up_the_allowance_in_order() {
        let (map, fra) = france();
        let mut position = Position::initial(map);
        // France lost its Marseilles army and so has one build
        position.remove_unit_at(map.find_province("mar").unwrap());
        let mut state = GameState::from_position(
            crate::state::Phase::new(1901, crate::state::Season::Winter, PhaseKind::Adjustment),
            position,
        );
        state.phase.kind = PhaseKind::Adjustment;
        let v = validate_orders(
            map,
            &state,
            Rulebook::default(),
            fra,
            &["F MAR B", "A MAR B", "A PAR B", "A MAR - SPA"],
        );
        assert_eq!(v[0].code, "ok");
        assert_eq!(v[0].canonical.as_deref(), Some("F MAR B"));
        assert_eq!(v[1].code, "allowance_used");
        assert_eq!(v[2].code, "allowance_used");
        assert_eq!(v[3].code, "wrong_phase");
        let v = validate_orders(
            map,
            &state,
            Rulebook::default(),
            fra,
            &["A PAR B", "A MUN B"],
        );
        assert_eq!(codes(&v), ["occupied", "not_home_center"]);
        let eng = map.find_power("ENGLAND").unwrap();
        let v = validate_orders(map, &state, Rulebook::default(), eng, &["A LON D", "WAIVE"]);
        assert_eq!(codes(&v), ["nothing_to_do", "nothing_to_do"]);
    }

    #[test]
    fn validation_never_changes_the_state() {
        let (map, fra) = france();
        let state = GameState::initial(map);
        let before = state.clone();
        validate_orders(
            map,
            &state,
            Rulebook::default(),
            fra,
            &["A PAR - BUR", "nonsense"],
        );
        assert_eq!(state, before);
    }
}
