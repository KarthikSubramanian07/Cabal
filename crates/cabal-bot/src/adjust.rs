//! Winter: what to build and where, or which units to give up.

use cabal_engine::geo::{Power, UnitKind};
use cabal_engine::legal::legal_adjustments;
use cabal_engine::order::{AdjustCommand, AdjustOrder};

use crate::board::Board;
use crate::rng::Rng;
use crate::values::Values;

/// Breadth-first distances over one unit kind's graph from a set of starting provinces.
fn distances(adj: &[Vec<usize>], from: &[usize]) -> Vec<u32> {
    let mut dist = vec![u32::MAX; adj.len()];
    let mut queue = std::collections::VecDeque::new();
    for &x in from {
        dist[x] = 0;
        queue.push_back(x);
    }
    while let Some(x) = queue.pop_front() {
        for &y in &adj[x] {
            if dist[y] == u32::MAX {
                dist[y] = dist[x] + 1;
                queue.push_back(y);
            }
        }
    }
    dist
}

/// Share of the power's force (in percent) that ought to be fleets, read off the
/// map: how much of what it does not yet own is nearer by sea than by land.
fn fleet_share_wanted(b: &Board, me: Power) -> i32 {
    let homes: Vec<usize> = (0..b.t.sc.len())
        .filter(|&x| b.t.home[x] == Some(me))
        .collect();
    let by_land = distances(&b.t.army, &homes);
    let by_sea = distances(&b.t.fleet, &homes);
    let pull = |dist: &[u32]| -> i64 {
        b.t.centres
            .iter()
            .filter(|&&c| b.owner[c] != Some(me) && dist[c] != u32::MAX)
            .map(|&c| 1000 / (1 + i64::from(dist[c])).pow(2))
            .sum()
    };
    let (land, sea) = (pull(&by_land), pull(&by_sea));
    if land + sea == 0 {
        return 30;
    }
    ((100 * sea / (land + sea)) as i32).clamp(15, 75)
}

pub(crate) fn decide(
    b: &Board,
    v: &Values,
    me: Power,
    rng: &mut Rng,
    noise: i32,
) -> Vec<AdjustOrder> {
    let (delta, legal) = legal_adjustments(b.map, b.pos, b.rulebook, me);
    let mut out: Vec<AdjustOrder> = Vec::new();
    if delta > 0 {
        let mine = b.units_of(me);
        let mut fleets = mine
            .iter()
            .filter(|&&i| b.unit(i).kind == UnitKind::Fleet)
            .count() as i32;
        let mut units = mine.len() as i32;
        let wanted = fleet_share_wanted(b, me);
        let mut used: Vec<usize> = Vec::new();
        for _ in 0..delta {
            let mut best: Option<(i32, AdjustOrder)> = None;
            for &o in &legal {
                let AdjustCommand::Build {
                    kind: Some(kind),
                    region,
                } = o.command
                else {
                    continue;
                };
                let x = region.province.0 as usize;
                if used.contains(&x) {
                    continue;
                }
                let share = if units == 0 { 0 } else { 100 * fleets / units };
                let balance = match kind {
                    UnitKind::Fleet => wanted - share,
                    UnitKind::Army => share - wanted,
                };
                // where the new unit could go next spring
                let outlook: i32 = b
                    .map
                    .reachable(region, kind)
                    .map(|r| v.of(kind, r.province.0 as usize))
                    .max()
                    .unwrap_or(0);
                let guard = 40 * b.enemy_reach(me, x).min(3);
                let s = v.of(kind, x) + outlook + 2 * balance + guard + rng.spread(noise);
                if best.is_none_or(|(bs, _)| s > bs) {
                    best = Some((s, o));
                }
            }
            match best {
                Some((_, o)) => {
                    if let AdjustCommand::Build {
                        kind: Some(kind),
                        region,
                    } = o.command
                    {
                        used.push(region.province.0 as usize);
                        units += 1;
                        fleets += i32::from(kind == UnitKind::Fleet);
                    }
                    out.push(o);
                }
                // no free home centre left: the build is waived, explicitly
                None => out.push(AdjustOrder {
                    power: me,
                    command: AdjustCommand::Waive,
                }),
            }
        }
    } else if delta < 0 {
        // keep the units that are doing something: guarding a centre or near a prize
        let mut keep: Vec<(i32, usize)> = b
            .units_of(me)
            .into_iter()
            .map(|i| {
                let u = b.unit(i);
                let x = u.province().0 as usize;
                let mut s = v.of(u.kind, x) + rng.spread(noise);
                if b.t.sc[x] && b.owner[x] == Some(me) {
                    s += 60 + 70 * b.enemy_reach(me, x).min(3);
                }
                if b.reach[i]
                    .iter()
                    .any(|r| b.prize(me, r.province.0 as usize))
                {
                    s += 90;
                }
                (s, i)
            })
            .collect();
        keep.sort();
        for &(_, i) in keep.iter().take(delta.unsigned_abs() as usize) {
            out.push(AdjustOrder {
                power: me,
                command: AdjustCommand::Disband {
                    unit: b.unit(i).province(),
                },
            });
        }
    }
    out
}
