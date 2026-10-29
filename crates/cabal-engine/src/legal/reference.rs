//! Test oracle: the legal movement enumeration as it was before the convoy
//! searches were shared per army, kept verbatim (helpers included) so the
//! property tests can prove the fast version returns exactly the same orders.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::geo::{Map, Power, ProvinceId, Region, UnitKind};
use crate::order::{Command, Order, Unit};
use crate::state::Position;

fn fleet_seas(map: &Map, position: &Position) -> BTreeSet<ProvinceId> {
    position
        .units
        .iter()
        .filter(|u| u.kind == UnitKind::Fleet && map.is_sea(u.province()))
        .map(|u| u.province())
        .collect()
}

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

fn can_reach(map: &Map, seas: &BTreeSet<ProvinceId>, unit: &Unit, p: ProvinceId) -> bool {
    map.adjacent_province(unit.region, unit.kind, p)
        || (unit.kind == UnitKind::Army
            && map.is_coastal(unit.province())
            && map.is_coastal(p)
            && convoy_possible(map, seas, unit.province(), p))
}

pub(crate) fn legal_movement(
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

fn fleet_adjacent(map: &Map, a: ProvinceId, b: ProvinceId) -> bool {
    map.regions_of(a)
        .into_iter()
        .any(|r| map.adjacent_province(r, UnitKind::Fleet, b))
}

fn convoy_possible(
    map: &Map,
    fleet_seas: &BTreeSet<ProvinceId>,
    origin: ProvinceId,
    dest: ProvinceId,
) -> bool {
    map.is_coastal(origin)
        && map.is_coastal(dest)
        && sea_path_exists(
            map,
            &fleet_seas.iter().copied().collect::<Vec<_>>(),
            origin,
            dest,
        )
}

fn on_convoy_route(
    map: &Map,
    fleet_seas: &BTreeSet<ProvinceId>,
    origin: ProvinceId,
    dest: ProvinceId,
    fleet: ProvinceId,
) -> bool {
    let seas: Vec<ProvinceId> = fleet_seas.iter().copied().collect();
    let adj = |a: ProvinceId, b: ProvinceId| fleet_adjacent(map, a, b);
    let mut chain = Vec::new();
    chordless_dfs(&seas, &mut chain, origin, dest, fleet, &adj)
}

fn chordless_dfs(
    seas: &[ProvinceId],
    chain: &mut Vec<ProvinceId>,
    origin: ProvinceId,
    dest: ProvinceId,
    fleet: ProvinceId,
    adj: &dyn Fn(ProvinceId, ProvinceId) -> bool,
) -> bool {
    let last = *chain.last().unwrap_or(&origin);
    let earlier: Vec<ProvinceId> = if chain.is_empty() {
        Vec::new()
    } else {
        std::iter::once(origin)
            .chain(chain[..chain.len() - 1].iter().copied())
            .collect()
    };
    if !chain.is_empty() && adj(last, dest) && chain.contains(&fleet) {
        let detour = chain[..chain.len() - 1].iter().any(|&e| adj(e, dest));
        if !detour {
            return true;
        }
    }
    for &s in seas {
        if chain.contains(&s) || !adj(last, s) || earlier.iter().any(|&e| adj(e, s)) {
            continue;
        }
        chain.push(s);
        let found = chordless_dfs(seas, chain, origin, dest, fleet, adj);
        chain.pop();
        if found {
            return true;
        }
    }
    false
}

fn reachable_seas(map: &Map, seas: &[ProvinceId], start: ProvinceId) -> BTreeSet<ProvinceId> {
    let mut seen = BTreeSet::new();
    let mut queue: VecDeque<ProvinceId> = seas
        .iter()
        .copied()
        .filter(|&s| fleet_adjacent(map, s, start))
        .collect();
    while let Some(s) = queue.pop_front() {
        if !seen.insert(s) {
            continue;
        }
        for &t in seas {
            if !seen.contains(&t) && map.adjacent(Region::land(s), UnitKind::Fleet, Region::land(t))
            {
                queue.push_back(t);
            }
        }
    }
    seen
}

fn sea_path_exists(map: &Map, seas: &[ProvinceId], origin: ProvinceId, dest: ProvinceId) -> bool {
    if seas.is_empty() || origin == dest {
        return false;
    }
    reachable_seas(map, seas, origin)
        .iter()
        .any(|&s| fleet_adjacent(map, s, dest))
}
