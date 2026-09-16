//! Property tests: the resolver never panics, is independent of order submission
//! sequence, is invariant under relabelling of powers, and only ever offers legal orders.

use std::collections::HashMap;

use cabal_engine::adjudicate::movement::resolve_movement;
use cabal_engine::geo::{Map, Power, Region, UnitKind};
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
}
