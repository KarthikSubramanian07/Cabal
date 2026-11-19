//! Retreats: go where the unit is worth most, never collide with a friend,
//! and avoid squares another dislodged unit is likely to pick.

use cabal_engine::geo::Power;
use cabal_engine::legal::legal_retreats;
use cabal_engine::order::{RetreatCommand, RetreatOrder};
use cabal_engine::state::GameState;

use crate::board::Board;
use crate::rng::Rng;
use crate::values::Values;

pub(crate) fn decide(
    b: &Board,
    v: &Values,
    state: &GameState,
    me: Power,
    rng: &mut Rng,
    noise: i32,
) -> Vec<RetreatOrder> {
    let options = legal_retreats(b.map, state, me);
    // squares some other power's dislodged unit could also retreat to
    let mut contested = vec![false; b.t.sc.len()];
    for q in b.map.power_ids().filter(|&q| q != me) {
        for list in legal_retreats(b.map, state, q).values() {
            for o in list {
                if let RetreatCommand::Retreat { dest, .. } = o.command {
                    contested[dest.0 as usize] = true;
                }
            }
        }
    }

    // score every option, then hand out the best ones without collisions
    let mut scored: Vec<(i32, RetreatOrder)> = Vec::new();
    for (unit, list) in &options {
        let Some(d) = state.dislodged.iter().find(|d| d.unit.province() == *unit) else {
            continue;
        };
        for &o in list {
            let RetreatCommand::Retreat { dest, .. } = o.command else {
                continue;
            };
            let x = dest.0 as usize;
            let mut s = 1000 + v.of(d.unit.kind, x) + rng.spread(noise);
            if b.prize(me, x) {
                s += if b.fall { 600 } else { 150 };
            }
            if b.t.sc[x] && b.owner[x] == Some(me) {
                // fall back onto our own centre, more so when it is under threat
                s += 80 + 60 * b.enemy_reach(me, x).min(3);
            }
            if contested[x] {
                s -= 200;
            }
            scored.push((s, o));
        }
    }
    scored.sort_by_key(|&(s, o)| (std::cmp::Reverse(s), o.unit));

    let mut out: Vec<RetreatOrder> = Vec::new();
    let mut taken = vec![false; b.t.sc.len()];
    for (_, o) in scored {
        let RetreatCommand::Retreat { dest, .. } = o.command else {
            continue;
        };
        if taken[dest.0 as usize] || out.iter().any(|done| done.unit == o.unit) {
            continue;
        }
        taken[dest.0 as usize] = true;
        out.push(o);
    }
    // anything left has nowhere to go
    for &unit in options.keys() {
        if !out.iter().any(|o| o.unit == unit) {
            out.push(RetreatOrder {
                power: me,
                unit,
                command: RetreatCommand::Disband,
            });
        }
    }
    out.sort_by_key(|o| o.unit);
    out
}
