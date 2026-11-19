//! A verdict and a ruling must never disagree: `validate_orders` calls an order
//! legal exactly when the resolver does not throw it out, and names the same
//! reason when it does. Swept over every unit, every power and a spread of
//! commands on two boards, legal and nonsensical alike.

use cabal_engine::geo::{Map, Power, ProvinceId, Region, UnitKind};
use cabal_engine::order::{Command, Order, Unit};
use cabal_engine::outcome::OrderOutcome;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::{GameState, Phase, PhaseKind, Position, Season};
use cabal_engine::text::order_text;
use cabal_engine::validate::validate_orders;
use cabal_engine::{legal, resolve_movement};

/// Fleets on every second sea and armies on every third coast, powers in rotation.
fn crowded(map: &Map) -> Position {
    let mut pos = Position::default();
    for (i, p) in map.province_ids().enumerate() {
        let (kind, wanted) = if map.is_sea(p) {
            (UnitKind::Fleet, i % 2 == 0)
        } else {
            (UnitKind::Army, i % 3 == 0)
        };
        if wanted && map.province(p).name != "swi" {
            pos.add_unit(Unit {
                power: Power((i % 7) as u8),
                kind,
                region: Region::land(p),
            });
        }
    }
    pos
}

fn sweep(map: &Map, position: &Position) -> (usize, usize) {
    let state = GameState::from_position(
        Phase::new(1901, Season::Spring, PhaseKind::Movement),
        position.clone(),
    );
    let rulebook = Rulebook::default();
    let (mut legal_seen, mut illegal_seen) = (0, 0);
    let provinces: Vec<ProvinceId> = map.province_ids().collect();
    for (n, &unit) in provinces.iter().enumerate() {
        for power in map.power_ids() {
            for (m, &dest) in provinces.iter().enumerate() {
                // a different slice of destinations for each unit keeps the sweep
                // broad without trying all 76 x 76 x 7 x 5 combinations
                if (n + m + power.0 as usize) % 5 != 0 {
                    continue;
                }
                let other = provinces[(n * 7 + m * 3) % provinces.len()];
                for command in [
                    Command::Hold,
                    Command::Move {
                        dest,
                        coast: None,
                        via_convoy: m % 2 == 0,
                    },
                    Command::SupportHold { target: dest },
                    Command::SupportMove {
                        target: dest,
                        dest: other,
                        coast: None,
                    },
                    Command::Convoy {
                        army: dest,
                        dest: other,
                    },
                ] {
                    let order = Order {
                        power,
                        unit,
                        command,
                    };
                    let text = order_text(map, position, &order);
                    let verdict = validate_orders(map, &state, rulebook, power, &[&text])
                        .pop()
                        .unwrap();
                    let result = resolve_movement(map, position, rulebook, &[order]);
                    match result.outcome_at(unit) {
                        None => assert_eq!(verdict.code, "no_unit", "{text}"),
                        Some(OrderOutcome::Illegal { reason, .. }) => {
                            assert!(!verdict.legal, "{text}: resolver says {reason:?}");
                            assert_eq!(verdict.code, reason.code(), "{text}");
                            illegal_seen += 1;
                        }
                        Some(_) => {
                            assert!(
                                verdict.legal,
                                "{text}: {} ({})",
                                verdict.code, verdict.reason
                            );
                            // a legal order is reported in the text adjudication uses
                            let i = result.orders.iter().position(|o| o.unit == unit).unwrap();
                            assert_eq!(
                                verdict.canonical.as_deref(),
                                Some(order_text(map, position, &result.orders[i]).as_str())
                            );
                            legal_seen += 1;
                        }
                    }
                }
            }
        }
    }
    (legal_seen, illegal_seen)
}

#[test]
fn verdicts_match_rulings_at_the_opening() {
    let map = Map::standard();
    let (legal, illegal) = sweep(map, &Position::initial(map));
    assert!(
        legal > 100 && illegal > 1000,
        "{legal} legal, {illegal} illegal"
    );
}

#[test]
fn verdicts_match_rulings_on_a_crowded_board() {
    let map = Map::standard();
    let (legal, illegal) = sweep(map, &crowded(map));
    assert!(
        legal > 300 && illegal > 3000,
        "{legal} legal, {illegal} illegal"
    );
}

#[test]
fn every_enumerated_order_is_judged_legal() {
    let map = Map::standard();
    for position in [Position::initial(map), crowded(map)] {
        let state = GameState::from_position(
            Phase::new(1901, Season::Spring, PhaseKind::Movement),
            position.clone(),
        );
        for (province, orders) in legal::legal_movement_all(map, &position) {
            let power = position.unit_at(province).unwrap().power;
            for order in orders {
                let text = order_text(map, &position, &order);
                let verdict = validate_orders(map, &state, Rulebook::default(), power, &[&text])
                    .pop()
                    .unwrap();
                assert!(verdict.legal, "{text}: {}", verdict.reason);
                assert_eq!(verdict.canonical.as_deref(), Some(text.as_str()));
            }
        }
    }
}
