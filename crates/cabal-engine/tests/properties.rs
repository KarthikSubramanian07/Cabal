//! Property tests: the resolver never panics, is independent of order submission
//! sequence, is invariant under relabelling of powers, only ever offers legal orders,
//! and rejects exactly the orders `normalise` rejects.

use std::collections::HashMap;

use cabal_engine::adjudicate::movement::resolve_movement;
use cabal_engine::geo::{Coast, Map, Power, ProvinceId, Region, UnitKind};
use cabal_engine::legal::legal_movement;
use cabal_engine::order::{Command, Order, Unit};
use cabal_engine::outcome::OrderOutcome;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::Position;
use proptest::prelude::*;

/// A random position: up to `n` units on distinct provinces, fleets only where fleets may be.
fn arb_position(n: usize) -> impl Strategy<Value = Position> {
    let map = Map::standard();
    let provinces = map.provinces().len();
    prop::collection::vec((0..provinces, 0..7u8, any::<bool>(), 0..2usize), 1..=n).prop_map(
        move |picks| {
            let mut pos = Position::default();
            for (p, power, fleet, coast_pick) in picks {
                let pid = cabal_engine::ProvinceId(p as u8);
                if pos.unit_at(pid).is_some() || map.province(pid).name == "swi" {
                    continue;
                }
                let prov = map.province(pid);
                let (kind, region) = if fleet && !map.is_inland(pid) {
                    let coast = prov
                        .coasts
                        .get(coast_pick % prov.coasts.len().max(1))
                        .copied();
                    (
                        UnitKind::Fleet,
                        Region::new(pid, if prov.coasts.is_empty() { None } else { coast }),
                    )
                } else if map.is_sea(pid) {
                    continue;
                } else {
                    (UnitKind::Army, Region::land(pid))
                };
                pos.add_unit(Unit {
                    power: Power(power),
                    kind,
                    region,
                });
            }
            pos
        },
    )
}

/// A crowded board: up to 19 fleets at sea plus up to 20 units on land, so convoys
/// are possible almost everywhere and convoy routes branch.
fn arb_crowded_position() -> impl Strategy<Value = Position> {
    let map = Map::standard();
    let seas: Vec<ProvinceId> = map.province_ids().filter(|&p| map.is_sea(p)).collect();
    let land: Vec<ProvinceId> = map
        .province_ids()
        .filter(|&p| !map.is_sea(p) && map.province(p).name != "swi")
        .collect();
    (
        prop::collection::vec((prop::sample::select(seas), 0..7u8), 0..=19),
        prop::collection::vec(
            (prop::sample::select(land), 0..7u8, any::<bool>(), 0..2usize),
            1..=20,
        ),
    )
        .prop_map(move |(fleets, others)| {
            let mut pos = Position::default();
            for (p, power) in fleets {
                if pos.unit_at(p).is_none() {
                    pos.add_unit(Unit {
                        power: Power(power),
                        kind: UnitKind::Fleet,
                        region: Region::land(p),
                    });
                }
            }
            for (p, power, fleet, coast_pick) in others {
                if pos.unit_at(p).is_some() {
                    continue;
                }
                let coasts = &map.province(p).coasts;
                let (kind, region) = if fleet && map.is_coastal(p) {
                    let coast = coasts.get(coast_pick % coasts.len().max(1)).copied();
                    (UnitKind::Fleet, Region::new(p, coast))
                } else {
                    (UnitKind::Army, Region::land(p))
                };
                pos.add_unit(Unit {
                    power: Power(power),
                    kind,
                    region,
                });
            }
            pos
        })
}

/// Any movement command at all, legal or not: random provinces and coasts.
fn arb_command() -> impl Strategy<Value = Command> {
    let provinces = Map::standard().provinces().len() as u8;
    let province = (0..provinces).prop_map(ProvinceId);
    let coast = prop::option::of(prop::sample::select(vec![
        Coast::North,
        Coast::South,
        Coast::East,
        Coast::West,
    ]));
    prop_oneof![
        Just(Command::Hold),
        (province.clone(), coast.clone(), any::<bool>()).prop_map(|(dest, coast, via_convoy)| {
            Command::Move {
                dest,
                coast,
                via_convoy,
            }
        }),
        province
            .clone()
            .prop_map(|target| Command::SupportHold { target }),
        (province.clone(), province.clone(), coast).prop_map(|(target, dest, coast)| {
            Command::SupportMove {
                target,
                dest,
                coast,
            }
        }),
        (province.clone(), province).prop_map(|(army, dest)| Command::Convoy { army, dest }),
    ]
}

/// One order per unit, each either one of its legal orders or an arbitrary command.
fn arb_mixed_orders(pos: &Position) -> BoxedStrategy<Vec<Order>> {
    let map = Map::standard();
    let mut strategies = Vec::new();
    for power in map.power_ids() {
        for (unit, legal) in legal_movement(map, pos, power) {
            let arbitrary = arb_command().prop_map(move |command| Order {
                power,
                unit,
                command,
            });
            strategies.push(prop_oneof![prop::sample::select(legal), arbitrary].boxed());
        }
    }
    strategies.boxed()
}

/// A random legal order set: for every unit, pick one of its legal orders.
fn arb_orders(pos: &Position) -> BoxedStrategy<Vec<Order>> {
    let map = Map::standard();
    let mut per_unit: Vec<Vec<Order>> = Vec::new();
    for power in map.power_ids() {
        for (_, orders) in legal_movement(map, pos, power) {
            per_unit.push(orders);
        }
    }
    let strategies: Vec<_> = per_unit.into_iter().map(prop::sample::select).collect();
    strategies.boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(256)))]

    #[test]
    fn prop_normalise_is_idempotent((pos, orders) in arb_position(14).prop_flat_map(|pos| { let o = arb_orders(&pos); o.prop_map(move |orders| (pos.clone(), orders)) })) {
        let map = Map::standard();
        for order in orders {
            let once = cabal_engine::order::normalise(map, &pos, order).expect("legal order");
            prop_assert_eq!(cabal_engine::order::normalise(map, &pos, once), Ok(once));
        }
    }

    #[test]
    fn prop_legal_orders_are_never_illegal(pos in arb_position(14)) {
        let map = Map::standard();
        for power in map.power_ids() {
            for (province, orders) in legal_movement(map, &pos, power) {
                for o in orders {
                    let r = resolve_movement(map, &pos, Rulebook::default(), &[o]);
                    let out = r.outcome_at(province).unwrap();
                    prop_assert!(!matches!(out, OrderOutcome::Illegal { .. }), "{o:?} => {out:?}");
                }
            }
        }
    }

    #[test]
    fn prop_resolution_is_order_independent((pos, orders) in arb_position(14).prop_flat_map(|pos| { let o = arb_orders(&pos); o.prop_map(move |orders| (pos.clone(), orders)) })) {
        let map = Map::standard();
        let a = resolve_movement(map, &pos, Rulebook::default(), &orders);
        let mut reversed = orders.clone();
        reversed.reverse();
        let b = resolve_movement(map, &pos, Rulebook::default(), &reversed);
        prop_assert_eq!(a.outcomes, b.outcomes);
        prop_assert_eq!(a.position, b.position);
        prop_assert_eq!(a.dislodged, b.dislodged);
    }

    #[test]
    fn prop_every_unit_is_accounted_for((pos, orders) in arb_position(14).prop_flat_map(|pos| { let o = arb_orders(&pos); o.prop_map(move |orders| (pos.clone(), orders)) })) {
        let map = Map::standard();
        let r = resolve_movement(map, &pos, Rulebook::default(), &orders);
        prop_assert_eq!(r.position.units.len() + r.dislodged.len(), pos.units.len());
        // no two units share a province afterwards
        let mut seen = std::collections::HashSet::new();
        for u in &r.position.units {
            prop_assert!(seen.insert(u.province()), "two units in {:?}", u.province());
        }
        // a dislodged unit's province is occupied by its attacker's unit
        for d in &r.dislodged {
            prop_assert!(r.position.unit_at(d.unit.province()).is_some());
        }
    }

    #[test]
    fn prop_relabelling_powers_relabels_outcomes((pos, orders) in arb_position(12).prop_flat_map(|pos| { let o = arb_orders(&pos); o.prop_map(move |orders| (pos.clone(), orders)) })) {
        let map = Map::standard();
        // swap powers 0 <-> 1 everywhere
        let swap = |p: Power| match p.0 { 0 => Power(1), 1 => Power(0), _ => p };
        let pos2 = Position {
            units: pos.units.iter().map(|u| Unit { power: swap(u.power), ..*u }).collect(),
            owners: pos.owners.iter().map(|(k, v)| (*k, swap(*v))).collect(),
        };
        let orders2: Vec<Order> = orders.iter().map(|o| Order { power: swap(o.power), ..*o }).collect();
        let a = resolve_movement(map, &pos, Rulebook::default(), &orders);
        let b = resolve_movement(map, &pos2, Rulebook::default(), &orders2);
        let by_unit = |r: &cabal_engine::MovementResult| -> HashMap<cabal_engine::ProvinceId, OrderOutcome> {
            r.orders.iter().zip(&r.outcomes).map(|(o, out)| (o.unit, out.clone())).collect()
        };
        prop_assert_eq!(by_unit(&a), by_unit(&b));
        let _ = Command::Hold;
    }

    #[test]
    fn prop_resolver_rejects_exactly_what_normalise_rejects((pos, orders) in arb_crowded_position().prop_flat_map(|pos| { let o = arb_mixed_orders(&pos); o.prop_map(move |orders| (pos.clone(), orders)) })) {
        let map = Map::standard();
        let r = resolve_movement(map, &pos, Rulebook::default(), &orders);
        for order in orders {
            let i = r.orders.iter().position(|o| o.unit == order.unit).unwrap();
            match cabal_engine::order::normalise(map, &pos, order) {
                Ok(canonical) => {
                    prop_assert!(!matches!(r.outcomes[i], OrderOutcome::Illegal { .. }), "{order:?} => {:?}", r.outcomes[i]);
                    prop_assert_eq!(r.orders[i], canonical);
                }
                Err(reason) => {
                    let judged = match &r.outcomes[i] {
                        OrderOutcome::Illegal { reason, .. } => Some(*reason),
                        _ => None,
                    };
                    prop_assert_eq!(judged, Some(reason), "{:?}", order);
                    prop_assert_eq!(r.orders[i].command, Command::Hold);
                }
            }
        }
    }
}
