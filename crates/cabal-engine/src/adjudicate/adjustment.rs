//! Adjustment (Winter) phase: builds, disbands and civil disorder removals (DATC 6.I, 6.J).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::geo::{Map, Power, ProvinceId, Region, SupplyCenter, UnitKind};
use crate::order::{AdjustCommand, AdjustOrder, Unit};
use crate::outcome::{AdjustIllegal, AdjustOutcome};
use crate::rulebook::{DisbandDistance, Rulebook};
use crate::state::Position;

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct AdjustmentResult {
    pub orders: Vec<AdjustOrder>,
    pub outcomes: Vec<AdjustOutcome>,
    pub position: Position,
    /// Units removed by the civil disorder rule because a power disbanded too few.
    pub civil_disorder: Vec<Unit>,
}

/// Units a power must build (positive) or remove (negative).
pub fn allowance(position: &Position, power: Power) -> i32 {
    position.count_centers(power) as i32 - position.count_units(power) as i32
}

/// Resolve the adjustment phase. `position.owners` must already reflect Fall ownership.
pub fn resolve_adjustment(
    map: &Map,
    position: &Position,
    rulebook: Rulebook,
    orders: &[AdjustOrder],
) -> AdjustmentResult {
    let mut pos = position.clone();
    let mut outcomes: Vec<AdjustOutcome> = Vec::with_capacity(orders.len());
    let mut remaining: HashMap<Power, i32> = map
        .power_ids()
        .map(|p| (p, allowance(position, p)))
        .collect();
    let mut removed: Vec<ProvinceId> = Vec::new();

    for o in orders {
        let left = *remaining.get(&o.power).unwrap_or(&0);
        let verdict = match o.command {
            AdjustCommand::Waive => {
                if left > 0 {
                    remaining.insert(o.power, left - 1);
                    Ok(())
                } else {
                    Err(AdjustIllegal::NothingToDo)
                }
            }
            AdjustCommand::Build { kind, region } => {
                if allowance(position, o.power) <= 0 {
                    Err(AdjustIllegal::NothingToDo)
                } else if left <= 0 {
                    Err(AdjustIllegal::AllowanceUsed)
                } else {
                    build_verdict(map, &pos, rulebook, o.power, kind, region).map(|unit| {
                        pos.add_unit(unit);
                        remaining.insert(o.power, left - 1);
                    })
                }
            }
            AdjustCommand::Disband { unit } => {
                if allowance(position, o.power) >= 0 {
                    Err(AdjustIllegal::NothingToDo)
                } else if left >= 0 {
                    Err(AdjustIllegal::AllowanceUsed)
                } else {
                    match pos.unit_at(unit) {
                        None => Err(if removed.contains(&unit) {
                            AdjustIllegal::AllowanceUsed
                        } else {
                            AdjustIllegal::NoUnit
                        }),
                        Some(u) if u.power != o.power => Err(AdjustIllegal::ForeignUnit),
                        Some(_) => {
                            pos.remove_unit_at(unit);
                            removed.push(unit);
                            remaining.insert(o.power, left + 1);
                            Ok(())
                        }
                    }
                }
            }
        };
        outcomes.push(match verdict {
            Ok(()) => AdjustOutcome::Succeeds,
            Err(reason) => AdjustOutcome::Illegal { reason },
        });
    }

    // civil disorder: remove what was not removed voluntarily (DATC 4.D.8)
    let mut civil_disorder = Vec::new();
    for power in map.power_ids() {
        let mut left = *remaining.get(&power).unwrap_or(&0);
        while left < 0 {
            let Some(victim) = civil_disorder_victim(map, &pos, rulebook, power) else {
                break;
            };
            pos.remove_unit_at(victim.province());
            civil_disorder.push(victim);
            left += 1;
        }
    }

    AdjustmentResult {
        orders: orders.to_vec(),
        outcomes,
        position: pos,
        civil_disorder,
    }
}

fn build_verdict(
    map: &Map,
    pos: &Position,
    rulebook: Rulebook,
    power: Power,
    kind: Option<UnitKind>,
    region: Region,
) -> Result<Unit, AdjustIllegal> {
    let p = region.province;
    let province = map.province(p);
    let is_home = province.supply_center == SupplyCenter::Home(power);
    let is_center = province.supply_center != SupplyCenter::None;
    if !(is_home || (rulebook.build_anywhere && is_center)) {
        return Err(AdjustIllegal::NotHomeCenter);
    }
    if pos.owners.get(&p) != Some(&power) {
        return Err(AdjustIllegal::NotOwned);
    }
    if pos.unit_at(p).is_some() {
        return Err(AdjustIllegal::Occupied);
    }
    // DATC 4.C.3: infer the kind when missing
    let kind = match kind {
        Some(k) => k,
        None => {
            if map.is_inland(p) {
                UnitKind::Army
            } else if region.coast.is_some() {
                UnitKind::Fleet
            } else {
                return Err(AdjustIllegal::BadTerrain);
            }
        }
    };
    let unit_region = match kind {
        UnitKind::Army => {
            if map.is_sea(p) {
                return Err(AdjustIllegal::BadTerrain);
            }
            Region::land(p)
        }
        UnitKind::Fleet => {
            if map.is_inland(p) {
                return Err(AdjustIllegal::BadTerrain);
            }
            if province.coasts.is_empty() {
                Region::land(p)
            } else {
                match region.coast {
                    Some(c) if province.coasts.contains(&c) => Region::new(p, Some(c)),
                    _ => return Err(AdjustIllegal::BadTerrain),
                }
            }
        }
    };
    Ok(Unit {
        power,
        kind,
        region: unit_region,
    })
}

/// The next unit to remove under civil disorder: farthest from the reference centres,
/// ties broken fleets first, then alphabetically by province name.
fn civil_disorder_victim(
    map: &Map,
    pos: &Position,
    rulebook: Rulebook,
    power: Power,
) -> Option<Unit> {
    let targets: Vec<ProvinceId> = match rulebook.disband_distance {
        DisbandDistance::OwnedCenters => pos.centers_of(power).collect(),
        DisbandDistance::HomeCenters => map.homes(power).to_vec(),
    };
    let mut units: Vec<(u32, u8, String, Unit)> = pos
        .units_of(power)
        .map(|&u| {
            let d = map.distance_any(u.province(), &targets).unwrap_or(u32::MAX);
            let kind_rank = if u.kind == UnitKind::Fleet { 0 } else { 1 };
            (d, kind_rank, map.province(u.province()).name.clone(), u)
        })
        .collect();
    units.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    units.first().map(|t| t.3)
}
