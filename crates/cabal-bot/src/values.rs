//! Province values: what each province is worth to one power right now.
//!
//! The scheme is the classic DAIDE "DumbBot" idea, recast in integers. Every
//! supply centre gets a base value (how much the power wants to take it, or how
//! badly it needs defending), and that value is then blurred outward over the
//! map so that a unit feels a pull from centres several moves away. Armies and
//! fleets get separate maps because they travel on different graphs.

use cabal_engine::geo::{Power, UnitKind};

use crate::board::Board;

/// Blur weights for the base value and its four successive neighbourhood averages.
/// In Spring the squares *next to* a prize matter most (get in position); in Fall
/// the prize itself does (be standing on it when ownership is counted).
const SPRING: [i32; 5] = [16, 40, 20, 10, 6];
const FALL: [i32; 5] = [48, 16, 10, 6, 4];

#[derive(Clone, Debug)]
pub(crate) struct Values {
    pub army: Vec<i32>,
    pub fleet: Vec<i32>,
}

impl Values {
    pub(crate) fn of(&self, kind: UnitKind, x: usize) -> i32 {
        match kind {
            UnitKind::Army => self.army[x],
            UnitKind::Fleet => self.fleet[x],
        }
    }
}

/// How much `me` wants each supply centre, before blurring. With a `grudge`,
/// that power's centres are worth far more: the view of a neighbour who has
/// decided to attack it.
fn base(b: &Board, me: Power, grudge: Option<Power>) -> Vec<i32> {
    let mut out = vec![0i32; b.t.sc.len()];
    for &c in &b.t.centres {
        out[c] = match b.owner[c] {
            Some(q) if q == me => {
                let threat = b.enemy_reach(me, c).min(3);
                if threat == 0 {
                    0
                } else {
                    45 * threat + if b.t.home[c] == Some(me) { 30 } else { 0 }
                }
            }
            None => 130,
            Some(q) => {
                let size = b.centres[q.0 as usize];
                let mut v = 80 + 4 * size;
                // stop the leader before the solo
                if size >= 10 {
                    v += 25 * (size - 9);
                }
                // a power on its last legs cannot defend what it has left
                if size <= 2 {
                    v += 20;
                }
                if grudge == Some(q) {
                    v += 160;
                }
                v
            }
        };
    }
    out
}

fn blur(adj: &[Vec<usize>], base: &[i32], weights: [i32; 5]) -> Vec<i32> {
    let n = base.len();
    let mut total: Vec<i32> = base.iter().map(|&v| v * weights[0]).collect();
    let mut prev = base.to_vec();
    for &w in &weights[1..] {
        let mut next = vec![0i32; n];
        for x in 0..n {
            if adj[x].is_empty() {
                continue;
            }
            let sum: i32 = adj[x].iter().map(|&y| prev[y]).sum();
            next[x] = (prev[x] + sum) / 5;
            total[x] += next[x] * w;
        }
        prev = next;
    }
    total.iter().map(|v| v / 16).collect()
}

pub(crate) fn compute(b: &Board, me: Power) -> Values {
    compute_with(b, me, None)
}

/// The map of a `me` that is set on attacking `victim`.
pub(crate) fn compute_hostile(b: &Board, me: Power, victim: Power) -> Values {
    compute_with(b, me, Some(victim))
}

fn compute_with(b: &Board, me: Power, grudge: Option<Power>) -> Values {
    let base = base(b, me, grudge);
    let weights = if b.fall { FALL } else { SPRING };
    // a fleet can never stand on an inland centre, so it must not be drawn to one
    let fleet_base: Vec<i32> = (0..base.len())
        .map(|x| if b.t.fleet[x].is_empty() { 0 } else { base[x] })
        .collect();
    Values {
        army: blur(&b.t.army, &base, weights),
        fleet: blur(&b.t.fleet, &fleet_base, weights),
    }
}

/// Season-independent values for adjustment decisions (always the Spring view:
/// a build is about where the unit can go next).
pub(crate) fn compute_spring(b: &Board, me: Power) -> Values {
    let base = base(b, me, None);
    let fleet_base: Vec<i32> = (0..base.len())
        .map(|x| if b.t.fleet[x].is_empty() { 0 } else { base[x] })
        .collect();
    Values {
        army: blur(&b.t.army, &base, SPRING),
        fleet: blur(&b.t.fleet, &fleet_base, SPRING),
    }
}
