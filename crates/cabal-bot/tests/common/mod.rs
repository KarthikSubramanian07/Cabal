//! Shared helpers for the bot's integration tests.
#![allow(dead_code)]

use std::collections::BTreeSet;

use cabal_bot::{Decision, Level, decide};
use cabal_engine::adjudicate::adjustment::allowance;
use cabal_engine::geo::{Map, Power, Region, UnitKind};
use cabal_engine::legal::{legal_adjustments, legal_movement, legal_retreats};
use cabal_engine::order::{AdjustCommand, AnyOrder, Command, Order, Unit};
use cabal_engine::outcome::{AdjustOutcome, OrderOutcome, RetreatOutcome};
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::{GameState, Phase, PhaseKind, Position};
use cabal_engine::text::{adjust_text, order_text, retreat_text};
use cabal_engine::{Game, PhaseResult};

pub fn map() -> &'static Map {
    Map::standard()
}

pub fn power(code: &str) -> Power {
    map()
        .find_power(code)
        .unwrap_or_else(|| panic!("power {code}"))
}

/// A position from lines like `FRA A PAR` and `RUS F STP/SC`, with ownership given
/// as `(power, [centres])`. Centres not listed belong to nobody.
pub fn position(units: &[&str], owners: &[(&str, &[&str])]) -> Position {
    let map = map();
    let mut pos = Position::default();
    for line in units {
        let mut parts = line.split_whitespace();
        let (p, k, r) = (
            parts.next().unwrap(),
            parts.next().unwrap(),
            parts.next().unwrap(),
        );
        let kind = if k == "F" {
            UnitKind::Fleet
        } else {
            UnitKind::Army
        };
        let region: Region = map.parse_region(r).unwrap_or_else(|| panic!("region {r}"));
        pos.add_unit(Unit {
            power: power(p),
            kind,
            region,
        });
    }
    for (p, centres) in owners {
        for c in *centres {
            let id = map
                .find_province(c)
                .unwrap_or_else(|| panic!("province {c}"));
            pos.owners.insert(id, power(p));
        }
    }
    pos
}

pub fn state(phase: &str, pos: Position) -> GameState {
    GameState::from_position(Phase::parse(phase).expect("phase"), pos)
}

/// The decision as canonical MILA order text, sorted.
pub fn texts(state: &GameState, d: &Decision) -> Vec<String> {
    let map = map();
    let pos = &state.position;
    let mut out: Vec<String> = d
        .orders
        .iter()
        .map(|o| match o {
            AnyOrder::Movement(o) => order_text(map, pos, o),
            AnyOrder::Retreat(o) => {
                // dislodged units are no longer on the board: name them from the retreat list
                let unit = state
                    .dislodged
                    .iter()
                    .find(|d| d.unit.province() == o.unit)
                    .map(|d| d.unit);
                let mut with_unit = pos.clone();
                if let Some(u) = unit {
                    if with_unit.unit_at(u.province()).is_none() {
                        with_unit.add_unit(u);
                    }
                }
                retreat_text(map, &with_unit, o)
            }
            AnyOrder::Adjustment(o) => adjust_text(map, pos, o),
        })
        .collect();
    out.sort();
    out
}

pub fn orders_for(state: &GameState, p: &str, seed: u64, level: Level) -> Vec<String> {
    let d = decide(map(), Rulebook::default(), state, power(p), seed, level);
    texts(state, &d)
}

/// Panic unless `d` is a complete, legal, duplicate-free order set for `p` in `state`.
pub fn assert_sound(state: &GameState, p: Power, d: &Decision, what: &str) {
    let map = map();
    let rules = Rulebook::default();
    let pos = &state.position;
    match state.phase.kind {
        PhaseKind::Movement => {
            let legal = legal_movement(map, pos, p);
            assert_eq!(d.orders.len(), legal.len(), "{what}: one order per unit");
            let mut seen = BTreeSet::new();
            for o in &d.orders {
                let AnyOrder::Movement(o) = o else {
                    panic!("{what}: wrong phase kind {o:?}")
                };
                assert_eq!(o.power, p, "{what}");
                assert!(
                    seen.insert(o.unit),
                    "{what}: duplicate order for {:?}",
                    o.unit
                );
                let menu = legal
                    .get(&o.unit)
                    .unwrap_or_else(|| panic!("{what}: no unit"));
                assert!(
                    menu.contains(o),
                    "{what}: {} is not on the legal menu",
                    order_text(map, pos, o)
                );
            }
            assert_consistent(d, what);
        }
        PhaseKind::Retreat => {
            let legal = legal_retreats(map, state, p);
            assert_eq!(
                d.orders.len(),
                legal.len(),
                "{what}: one order per dislodged unit"
            );
            let mut seen = BTreeSet::new();
            let mut dests = BTreeSet::new();
            for o in &d.orders {
                let AnyOrder::Retreat(o) = o else {
                    panic!("{what}: wrong phase kind {o:?}")
                };
                assert!(seen.insert(o.unit), "{what}: duplicate retreat");
                assert!(legal[&o.unit].contains(o), "{what}: illegal retreat {o:?}");
                if let cabal_engine::RetreatCommand::Retreat { dest, .. } = o.command {
                    assert!(
                        dests.insert(dest),
                        "{what}: two own units retreat to one province"
                    );
                }
            }
        }
        PhaseKind::Adjustment => {
            let (delta, legal) = legal_adjustments(map, pos, rules, p);
            assert_eq!(delta, allowance(pos, p));
            assert_eq!(
                d.orders.len(),
                delta.unsigned_abs() as usize,
                "{what}: fills the allowance of {delta}"
            );
            let mut sites = BTreeSet::new();
            let free_sites: BTreeSet<_> = legal
                .iter()
                .filter_map(|o| match o.command {
                    AdjustCommand::Build { region, .. } => Some(region.province),
                    _ => None,
                })
                .collect();
            let mut builds = 0;
            for o in &d.orders {
                let AnyOrder::Adjustment(o) = o else {
                    panic!("{what}: wrong phase kind {o:?}")
                };
                assert!(legal.contains(o), "{what}: illegal adjustment {o:?}");
                match o.command {
                    AdjustCommand::Build { region, .. } => {
                        builds += 1;
                        assert!(
                            sites.insert(region.province),
                            "{what}: two builds on one centre"
                        );
                    }
                    AdjustCommand::Disband { unit } => {
                        assert!(sites.insert(unit), "{what}: one unit disbanded twice");
                    }
                    AdjustCommand::Waive => {}
                }
            }
            if delta > 0 {
                // a waive is only acceptable when every free site is already used
                assert_eq!(
                    builds,
                    (delta as usize).min(free_sites.len()),
                    "{what}: waived a build it could have made"
                );
            }
        }
    }
}

/// Panic unless a movement decision is internally consistent: no order that
/// contradicts another of the same power, nothing the validator had to replace,
/// and every support the intent reports is one the orders really contain and
/// the supported unit (when it is the bot's own) really benefits from.
pub fn assert_consistent(d: &Decision, what: &str) {
    let mine: Vec<Order> = d
        .orders
        .iter()
        .filter_map(|o| match o {
            AnyOrder::Movement(o) => Some(*o),
            _ => None,
        })
        .collect();
    assert_eq!(
        cabal_bot::contradictions(&mine),
        0,
        "{what}: orders contradict each other: {mine:?}"
    );
    assert_eq!(
        d.intent.rejected, 0,
        "{what}: the planner proposed an order the validator refused"
    );
    let supports = mine
        .iter()
        .filter(|o| {
            matches!(
                o.command,
                Command::SupportHold { .. } | Command::SupportMove { .. }
            )
        })
        .count();
    assert_eq!(
        d.intent.supports.len(),
        supports,
        "{what}: the intent must report every support, and only real ones"
    );
    for s in &d.intent.supports {
        let order = mine.iter().find(|o| o.unit == s.unit).map(|o| o.command);
        let matches = match (order, s.dest) {
            (Some(Command::SupportMove { target, dest, .. }), Some(x)) => {
                target == s.target && dest == x
            }
            (Some(Command::SupportHold { target }), None) => target == s.target,
            _ => false,
        };
        assert!(matches, "{what}: intent support {s:?} is not in the orders");
        if let Some(theirs) = mine.iter().find(|o| o.unit == s.target) {
            let going = match theirs.command {
                Command::Move { dest, .. } => Some(dest),
                _ => None,
            };
            assert_eq!(
                going, s.dest,
                "{what}: {s:?} supports something not ordered"
            );
        }
    }
}

/// Adjudicate everybody's decisions and panic on any illegal outcome.
pub fn assert_adjudicates_clean(game: &Game, orders: &[AnyOrder], what: &str) {
    let mut next = game.clone();
    let result = next.process(orders).expect("active game");
    let illegal = match result {
        PhaseResult::Movement(r) => r
            .outcomes
            .iter()
            .filter(|o| matches!(o, OrderOutcome::Illegal { .. }))
            .count(),
        PhaseResult::Retreat(r) => r
            .outcomes
            .iter()
            .filter(|o| matches!(o, RetreatOutcome::Illegal { .. }))
            .count(),
        PhaseResult::Adjustment(r) => r
            .outcomes
            .iter()
            .filter(|o| matches!(o, AdjustOutcome::Illegal { .. }))
            .count(),
    };
    assert_eq!(
        illegal, 0,
        "{what}: the engine judged {illegal} orders illegal"
    );
}
