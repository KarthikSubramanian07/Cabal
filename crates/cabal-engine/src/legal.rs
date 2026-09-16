//! Legal order enumeration.
//!
//! Every AI harness and the order composer in the client need the complete set
//! of orders a unit may be given. The lists here are exactly the orders the
//! resolvers accept as legal, so a client that only offers these never submits
//! an illegal order.

use std::collections::{BTreeMap, BTreeSet};

use crate::adjudicate::movement::{convoy_possible, on_convoy_route};
use crate::geo::{Map, Power, ProvinceId, Region, SupplyCenter, UnitKind};
use crate::order::{
    AdjustCommand, AdjustOrder, Command, Order, RetreatCommand, RetreatOrder, Unit,
};
use crate::rulebook::Rulebook;
use crate::state::{GameState, Position};

fn fleet_seas(map: &Map, position: &Position) -> BTreeSet<ProvinceId> {
    position
        .units
        .iter()
        .filter(|u| u.kind == UnitKind::Fleet && map.is_sea(u.province()))
        .map(|u| u.province())
        .collect()
}

/// Regions a unit can move to directly, plus (for armies) provinces reachable by convoy.
fn destinations(map: &Map, seas: &BTreeSet<ProvinceId>, unit: &Unit) -> Vec<(Region, bool)> {
    let mut out: Vec<(Region, bool)> = Vec::new();
    for r in map.reachable(unit.region, unit.kind) {
        out.push((r, false));
    }
    if unit.kind == UnitKind::Army && map.is_coastal(unit.province()) {
        for p in map.province_ids() {
            if p != unit.province()
                && map.is_coastal(p)
                && convoy_possible(map, seas, unit.province(), p)
            {
                out.push((Region::land(p), true));
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Can `unit` reach province `p` (directly, or for armies by some convoy)?
fn can_reach(map: &Map, seas: &BTreeSet<ProvinceId>, unit: &Unit, p: ProvinceId) -> bool {
    map.adjacent_province(unit.region, unit.kind, p)
        || (unit.kind == UnitKind::Army
            && map.is_coastal(unit.province())
            && map.is_coastal(p)
            && convoy_possible(map, seas, unit.province(), p))
}

/// All legal movement orders for every unit of `power`, keyed by the unit's province.
pub fn legal_movement(
    map: &Map,
    position: &Position,
    power: Power,
) -> BTreeMap<ProvinceId, Vec<Order>> {
    let seas = fleet_seas(map, position);
    let mut out = BTreeMap::new();
    for unit in position.units_of(power) {
        let mut orders = vec![Order {
            power,
            unit: unit.province(),
            command: Command::Hold,
        }];
        // moves
        for (r, via) in destinations(map, &seas, unit) {
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
                if can_reach(map, &seas, other, p) {
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
                        && on_convoy_route(map, &seas, army.province(), dest, unit.province())
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
