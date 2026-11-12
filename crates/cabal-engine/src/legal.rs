//! Legal order enumeration.
//!
//! Every AI harness and the order composer in the client need the complete set
//! of orders a unit may be given. The lists here are exactly the orders the
//! resolvers accept as legal, so a client that only offers these never submits
//! an illegal order.

use std::collections::{BTreeMap, BTreeSet};

use crate::adjudicate::movement::{convoy_destinations, convoy_route_fleets};
use crate::geo::{Map, Power, ProvinceId, Region, SupplyCenter, UnitKind};
use crate::order::{
    AdjustCommand, AdjustOrder, Command, Order, RetreatCommand, RetreatOrder, Unit, fleet_seas,
};
use crate::rulebook::Rulebook;
use crate::state::{GameState, Position};

#[cfg(test)]
mod reference;

/// Convoy reachability for one position, searched once per army and shared by every
/// order that asks about it.
struct Convoys {
    /// Province count, the row length of `routes`.
    n: usize,
    /// For each coastal army (by province id): provinces it can reach by some convoy.
    dests: Vec<Option<Vec<bool>>>,
    /// For each coastal army (by province id), when the power has a fleet at sea:
    /// `[dest * n + fleet]` is set when `fleet` is on a convoy route to `dest`.
    routes: Vec<Option<Vec<bool>>>,
}

impl Convoys {
    fn new(map: &Map, position: &Position, seas: &BTreeSet<ProvinceId>, power: Power) -> Self {
        let n = map.provinces().len();
        let convoys = position
            .units_of(power)
            .any(|u| u.kind == UnitKind::Fleet && map.is_sea(u.province()));
        let mut dests = vec![None; n];
        let mut routes = vec![None; n];
        if seas.is_empty() {
            // no fleet at sea: nothing can be convoyed (the 1901 position)
            return Convoys { n, dests, routes };
        }
        for army in position
            .units
            .iter()
            .filter(|a| a.kind == UnitKind::Army && map.is_coastal(a.province()))
        {
            let i = army.province().0 as usize;
            dests[i] = Some(convoy_destinations(map, seas, army.province()));
            if convoys {
                routes[i] = Some(convoy_route_fleets(map, seas, army.province()));
            }
        }
        Convoys { n, dests, routes }
    }

    /// Can the army in `origin` reach `dest` by some convoy?
    fn possible(&self, origin: ProvinceId, dest: ProvinceId) -> bool {
        self.dests[origin.0 as usize]
            .as_ref()
            .is_some_and(|d| d[dest.0 as usize])
    }

    /// Is `fleet` on some convoy route for the army in `origin` to `dest`?
    fn on_route(&self, origin: ProvinceId, dest: ProvinceId, fleet: ProvinceId) -> bool {
        self.routes[origin.0 as usize]
            .as_ref()
            .is_some_and(|r| r[dest.0 as usize * self.n + fleet.0 as usize])
    }
}

/// Regions a unit can move to directly, plus (for armies) provinces reachable by convoy.
fn destinations(map: &Map, convoys: &Convoys, unit: &Unit) -> Vec<(Region, bool)> {
    let mut out: Vec<(Region, bool)> = Vec::new();
    for r in map.reachable(unit.region, unit.kind) {
        out.push((r, false));
    }
    if unit.kind == UnitKind::Army && map.is_coastal(unit.province()) {
        for p in map.province_ids() {
            if convoys.possible(unit.province(), p) {
                out.push((Region::land(p), true));
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Can `unit` reach province `p` (directly, or for armies by some convoy)?
fn can_reach(map: &Map, convoys: &Convoys, unit: &Unit, p: ProvinceId) -> bool {
    map.adjacent_province(unit.region, unit.kind, p)
        || (unit.kind == UnitKind::Army && convoys.possible(unit.province(), p))
}

/// All legal movement orders for every unit of `power`, keyed by the unit's province.
pub fn legal_movement(
    map: &Map,
    position: &Position,
    power: Power,
) -> BTreeMap<ProvinceId, Vec<Order>> {
    let seas = fleet_seas(map, position);
    let convoys = Convoys::new(map, position, &seas, power);
    let mut out = BTreeMap::new();
    for unit in position.units_of(power) {
        let mut orders = vec![Order {
            power,
            unit: unit.province(),
            command: Command::Hold,
        }];
        // moves
        for (r, via) in destinations(map, &convoys, unit) {
            let coast = if map.province(r.province).coasts.is_empty() {
                None
            } else {
                r.coast
            };
            orders.push(Order {
                power,
                unit: unit.province(),
                command: Command::Move {
                    dest: r.province,
                    coast,
                    via_convoy: via,
                },
            });
        }
        // supports: any province this unit could move to directly
        let mut targets: Vec<ProvinceId> = map
            .reachable(unit.region, unit.kind)
            .map(|r| r.province)
            .collect();
        targets.sort();
        targets.dedup();
        for p in targets {
            if let Some(occ) = position.unit_at(p) {
                if occ.province() != unit.province() {
                    orders.push(Order {
                        power,
                        unit: unit.province(),
                        command: Command::SupportHold { target: p },
                    });
                }
            }
            for other in &position.units {
                if other.province() == unit.province() || other.province() == p {
                    continue;
                }
                if can_reach(map, &convoys, other, p) {
                    orders.push(Order {
                        power,
                        unit: unit.province(),
                        command: Command::SupportMove {
                            target: other.province(),
                            dest: p,
                            coast: None,
                        },
                    });
                }
            }
        }
        // convoys
        if unit.kind == UnitKind::Fleet && map.is_sea(unit.province()) {
            for army in position
                .units
                .iter()
                .filter(|a| a.kind == UnitKind::Army && map.is_coastal(a.province()))
            {
                for dest in map.province_ids() {
                    if dest != army.province()
                        && map.is_coastal(dest)
                        && convoys.on_route(army.province(), dest, unit.province())
                    {
                        orders.push(Order {
                            power,
                            unit: unit.province(),
                            command: Command::Convoy {
                                army: army.province(),
                                dest,
                            },
                        });
                    }
                }
            }
        }
        out.insert(unit.province(), orders);
    }
    out
}

/// All legal retreat orders for every dislodged unit of `power`.
pub fn legal_retreats(
    map: &Map,
    state: &GameState,
    power: Power,
) -> BTreeMap<ProvinceId, Vec<RetreatOrder>> {
    let mut out = BTreeMap::new();
    for d in state.dislodged.iter().filter(|d| d.unit.power == power) {
        let unit = d.unit;
        let mut orders = vec![RetreatOrder {
            power,
            unit: unit.province(),
            command: RetreatCommand::Disband,
        }];
        let mut regions: Vec<Region> = map.reachable(unit.region, unit.kind).collect();
        regions.sort();
        regions.dedup();
        for r in regions {
            let p = r.province;
            if state.position.unit_at(p).is_some()
                || state.standoffs.contains(&p)
                || (p == d.attacker_from && !d.by_convoy)
            {
                continue;
            }
            let coast = if map.province(p).coasts.is_empty() {
                None
            } else {
                r.coast
            };
            orders.push(RetreatOrder {
                power,
                unit: unit.province(),
                command: RetreatCommand::Retreat { dest: p, coast },
            });
        }
        out.insert(unit.province(), orders);
    }
    out
}

/// All legal adjustment orders for `power` (builds and waive, or disbands), with the allowance.
pub fn legal_adjustments(
    map: &Map,
    position: &Position,
    rulebook: Rulebook,
    power: Power,
) -> (i32, Vec<AdjustOrder>) {
    let delta = crate::adjudicate::adjustment::allowance(position, power);
    let mut orders = Vec::new();
    if delta > 0 {
        for p in map.province_ids() {
            let prov = map.province(p);
            let home = prov.supply_center == SupplyCenter::Home(power);
            let any = rulebook.build_anywhere && prov.supply_center != SupplyCenter::None;
            if !(home || any)
                || position.owners.get(&p) != Some(&power)
                || position.unit_at(p).is_some()
            {
                continue;
            }
            if !map.is_sea(p) {
                orders.push(AdjustOrder {
                    power,
                    command: AdjustCommand::Build {
                        kind: Some(UnitKind::Army),
                        region: Region::land(p),
                    },
                });
            }
            if !map.is_inland(p) {
                if prov.coasts.is_empty() {
                    orders.push(AdjustOrder {
                        power,
                        command: AdjustCommand::Build {
                            kind: Some(UnitKind::Fleet),
                            region: Region::land(p),
                        },
                    });
                } else {
                    for &c in &prov.coasts {
                        orders.push(AdjustOrder {
                            power,
                            command: AdjustCommand::Build {
                                kind: Some(UnitKind::Fleet),
                                region: Region::new(p, Some(c)),
                            },
                        });
                    }
                }
            }
        }
        orders.push(AdjustOrder {
            power,
            command: AdjustCommand::Waive,
        });
    } else if delta < 0 {
        for u in position.units_of(power) {
            orders.push(AdjustOrder {
                power,
                command: AdjustCommand::Disband { unit: u.province() },
            });
        }
    }
    (delta, orders)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adjudicate::movement::resolve_movement;
    use crate::outcome::OrderOutcome;
    use proptest::prelude::*;

    /// A crowded board: up to 19 fleets at sea plus up to 20 units on land, so most
    /// armies are convoyable and convoy routes branch (the shape that made the old
    /// per-order route searches slow).
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
                0..=20,
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

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(
            std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(64)
        ))]

        #[test]
        fn prop_legal_movement_matches_reference(pos in arb_crowded_position()) {
            let map = Map::standard();
            for power in map.power_ids() {
                prop_assert_eq!(
                    legal_movement(map, &pos, power),
                    reference::legal_movement(map, &pos, power),
                    "power {:?} on {:?}", power, pos.units
                );
            }
        }
    }

    #[test]
    fn midgame_matches_reference() {
        let map = Map::standard();
        let mut pos = Position::default();
        let seas: Vec<ProvinceId> = map.province_ids().filter(|&p| map.is_sea(p)).collect();
        for (i, &p) in seas.iter().enumerate() {
            pos.add_unit(Unit {
                power: Power((i % 7) as u8),
                kind: UnitKind::Fleet,
                region: Region::land(p),
            });
        }
        for (i, p) in map
            .province_ids()
            .filter(|&p| map.is_coastal(p))
            .enumerate()
        {
            if i % 2 == 0 {
                pos.add_unit(Unit {
                    power: Power((i % 7) as u8),
                    kind: UnitKind::Army,
                    region: Region::land(p),
                });
            }
        }
        for power in map.power_ids() {
            assert_eq!(
                legal_movement(map, &pos, power),
                reference::legal_movement(map, &pos, power)
            );
        }
    }

    #[test]
    fn opening_position_orders_are_all_legal() {
        let map = Map::standard();
        let pos = Position::initial(map);
        let mut total = 0;
        for power in map.power_ids() {
            for (province, orders) in legal_movement(map, &pos, power) {
                for o in orders {
                    total += 1;
                    let r = resolve_movement(map, &pos, Rulebook::default(), &[o]);
                    let outcome = r.outcome_at(province).unwrap();
                    assert!(
                        !matches!(outcome, OrderOutcome::Illegal { .. }),
                        "{o:?} judged illegal: {outcome:?}"
                    );
                }
            }
        }
        assert!(
            total > 200,
            "expected a rich opening order set, got {total}"
        );
    }

    #[test]
    fn opening_builds_and_retreats() {
        let map = Map::standard();
        let pos = Position::initial(map);
        for power in map.power_ids() {
            let (delta, orders) = legal_adjustments(map, &pos, Rulebook::default(), power);
            assert_eq!(delta, 0);
            assert!(orders.is_empty());
        }
        let state = GameState::initial(map);
        assert!(legal_retreats(map, &state, Power(0)).is_empty());
    }
}
