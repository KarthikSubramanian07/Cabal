//! Retreat phase resolution (DATC 6.H).
//!
//! A dislodged unit may retreat to an adjacent province that is empty, was not
//! the origin of its attacker (unless the attacker arrived by convoy, DATC 4.A.5),
//! and was not left vacant by a standoff. Two or more units retreating to the
//! same province all disband. Anything else disbands.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::geo::{CoastError, Map, ProvinceId, Region, UnitKind};
use crate::order::{RetreatCommand, RetreatOrder, Unit};
use crate::outcome::{RetreatIllegal, RetreatOutcome};
use crate::state::GameState;

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct RetreatResult {
    /// One order per dislodged unit (disband injected when missing), plus any stray orders received.
    pub orders: Vec<RetreatOrder>,
    pub outcomes: Vec<RetreatOutcome>,
    /// Position with successful retreats placed. Ownership unchanged.
    pub position: crate::state::Position,
}

impl RetreatResult {
    pub fn outcome_at(&self, province: ProvinceId) -> Option<&RetreatOutcome> {
        self.orders
            .iter()
            .position(|o| o.unit == province)
            .map(|i| &self.outcomes[i])
    }
}

/// Resolve the retreat phase for `state` (which must carry `dislodged` and `standoffs`).
pub fn resolve_retreat(map: &Map, state: &GameState, orders: &[RetreatOrder]) -> RetreatResult {
    let mut per_unit: HashMap<ProvinceId, Vec<&RetreatOrder>> = HashMap::new();
    for o in orders {
        per_unit.entry(o.unit).or_default().push(o);
    }

    let mut out_orders: Vec<RetreatOrder> = Vec::new();
    let mut outcomes: Vec<RetreatOutcome> = Vec::new();
    // (index into out_orders, destination region) for candidate retreats
    let mut candidates: Vec<(usize, Region, Unit)> = Vec::new();

    for d in &state.dislodged {
        let unit = d.unit;
        let list = per_unit.remove(&unit.province()).unwrap_or_default();
        let order = match list.as_slice() {
            [o] if o.power == unit.power => **o,
            _ => RetreatOrder {
                power: unit.power,
                unit: unit.province(),
                command: RetreatCommand::Disband,
            },
        };
        let idx = out_orders.len();
        out_orders.push(order);
        match order.command {
            RetreatCommand::Disband => outcomes.push(RetreatOutcome::Disbanded),
            RetreatCommand::Retreat { dest, coast } => {
                let verdict = if dest == unit.province() {
                    Err(RetreatIllegal::Unreachable)
                } else {
                    let region = match unit.kind {
                        UnitKind::Army => {
                            if map.adjacent_province(unit.region, UnitKind::Army, dest) {
                                Ok(Region::land(dest))
                            } else {
                                Err(RetreatIllegal::Unreachable)
                            }
                        }
                        UnitKind::Fleet => match map.fleet_destination(unit.region, dest, coast) {
                            Ok(r) => Ok(r),
                            Err(CoastError::Ambiguous) => Err(RetreatIllegal::AmbiguousCoast),
                            Err(CoastError::Unreachable) => Err(RetreatIllegal::Unreachable),
                        },
                    };
                    region.and_then(|r| {
                        if state.position.unit_at(dest).is_some() {
                            Err(RetreatIllegal::Occupied)
                        } else if dest == d.attacker_from && !d.by_convoy {
                            Err(RetreatIllegal::AttackerOrigin)
                        } else if state.standoffs.contains(&dest) {
                            Err(RetreatIllegal::Standoff)
                        } else {
                            Ok(r)
                        }
                    })
                };
                match verdict {
                    Ok(region) => {
                        candidates.push((idx, region, unit));
                        outcomes.push(RetreatOutcome::Succeeds); // provisional
                    }
                    Err(reason) => outcomes.push(RetreatOutcome::Illegal { reason }),
                }
            }
        }
    }

    // stray orders for units that were not dislodged
    let mut strays: Vec<&RetreatOrder> = per_unit.into_values().flatten().collect();
    strays.sort_by_key(|o| (o.unit, o.power));
    for o in strays {
        out_orders.push(*o);
        outcomes.push(RetreatOutcome::Illegal {
            reason: RetreatIllegal::NotDislodged,
        });
    }

    // bounces: two or more retreats to the same province all disband
    let mut by_dest: HashMap<ProvinceId, Vec<usize>> = HashMap::new();
    for (i, (idx, region, _)) in candidates.iter().enumerate() {
        let _ = idx;
        by_dest.entry(region.province).or_default().push(i);
    }
    let mut position = state.position.clone();
    for (_, group) in by_dest {
        if group.len() > 1 {
            for &i in &group {
                let (idx, _, _) = candidates[i];
                let with: Vec<ProvinceId> = group
                    .iter()
                    .filter(|&&j| j != i)
                    .map(|&j| candidates[j].2.province())
                    .collect();
                outcomes[idx] = RetreatOutcome::Bounced { with };
            }
        } else {
            let (_, region, unit) = candidates[group[0]];
            position.add_unit(Unit { region, ..unit });
        }
    }

    RetreatResult {
        orders: out_orders,
        outcomes,
        position,
    }
}
