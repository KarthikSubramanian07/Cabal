//! The prior: one plausible joint order set for a power, built greedily.
//!
//! Each unit in turn picks its best destination from the value map (with seeded
//! noise for variety), then idle or low-value units are converted into supports
//! for the moves and holds that need them, and finally self-blocking moves are
//! repaired. The search in [`crate::search`] treats the outputs as candidates
//! for the bot itself and as a model of what each rival might do.

use cabal_engine::geo::{Power, ProvinceId, Region, UnitKind};
use cabal_engine::order::{Command, Order};

use crate::board::Board;
use crate::rng::Rng;
use crate::values::Values;

/// What one unit has been told to do, by unit index.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Choice {
    Undecided,
    Stay,
    Go(Region),
    /// Army carried by `fleet` to `dest`.
    Via {
        dest: usize,
        fleet: usize,
    },
    /// Fleet carrying `army` to `dest`.
    Convoy {
        army: usize,
        dest: usize,
    },
    SupHold(usize),
    SupMove {
        target: usize,
        dest: usize,
    },
}

pub(crate) fn command(b: &Board, choice: Choice) -> Command {
    let prov = |i: usize| b.unit(i).province();
    match choice {
        Choice::Undecided | Choice::Stay => Command::Hold,
        Choice::Go(r) => move_to(b, r),
        Choice::Via { dest, .. } => Command::Move {
            dest: ProvinceId(dest as u8),
            coast: None,
            via_convoy: true,
        },
        Choice::Convoy { army, dest } => Command::Convoy {
            army: prov(army),
            dest: ProvinceId(dest as u8),
        },
        Choice::SupHold(t) => Command::SupportHold { target: prov(t) },
        Choice::SupMove { target, dest } => Command::SupportMove {
            target: prov(target),
            dest: ProvinceId(dest as u8),
            coast: None,
        },
    }
}

/// A direct move to a region, with the coast named only where the province has coasts.
pub(crate) fn move_to(b: &Board, r: Region) -> Command {
    Command::Move {
        dest: r.province,
        coast: if b.map.province(r.province).coasts.is_empty() {
            None
        } else {
            r.coast
        },
        via_convoy: false,
    }
}

/// Prior worth of unit `i` ending the turn in `x` (staying when `x` is where it stands).
pub(crate) fn dest_score(
    b: &Board,
    v: &Values,
    me: Power,
    kind: UnitKind,
    x: usize,
    stay: bool,
) -> i32 {
    let mut s = v.of(kind, x);
    let enemy = b.enemy_reach(me, x);
    let prize = b.prize(me, x);
    if stay {
        if prize {
            s += if b.fall { 600 } else { 150 };
        }
        if b.t.sc[x] && b.owner[x] == Some(me) && enemy > 0 {
            s += if b.fall { 250 } else { 120 };
        }
    } else {
        let defended = b.foreign_at(me, x).is_some();
        if prize {
            s += match (b.fall, defended, enemy) {
                (true, true, _) => 150,
                (true, false, 0) => 600,
                (true, false, _) => 350,
                (false, true, _) => 60,
                (false, false, _) => 150,
            };
        }
        s -= 10 * enemy;
        if defended {
            s -= 50;
        }
    }
    s
}

struct Task {
    target: usize,
    /// `None`: the target holds and wants support in place.
    dest: Option<usize>,
    need: i32,
    value: i32,
}

/// Build one joint order set for `me`. `noise` is the amplitude of the seeded
/// jitter added to every score; zero gives the plain greedy plan.
pub(crate) fn sample(b: &Board, v: &Values, me: Power, rng: &mut Rng, noise: i32) -> Vec<Order> {
    let mine = b.units_of(me);
    if mine.is_empty() {
        return Vec::new();
    }
    let total = b.pos.units.len();
    let mut choice = vec![Choice::Undecided; total];
    let mut gain = vec![0i32; total];
    let mut stay_score = vec![0i32; total];
    let mut claimed = vec![false; b.t.sc.len()];

    // --- destinations ---
    let mut order = mine.clone();
    if noise > 0 {
        rng.shuffle(&mut order);
    } else {
        // most valuable prospects first, so they get first claim
        let best = |i: usize| {
            let u = b.unit(i);
            b.reach[i]
                .iter()
                .map(|r| dest_score(b, v, me, u.kind, r.province.0 as usize, false))
                .max()
                .unwrap_or(i32::MIN)
        };
        order.sort_by_key(|&i| (std::cmp::Reverse(best(i)), i));
    }
    for &i in &order {
        if choice[i] != Choice::Undecided {
            continue; // already committed as a convoying fleet
        }
        let u = *b.unit(i);
        let here = u.province().0 as usize;
        let stay = dest_score(b, v, me, u.kind, here, true) + rng.spread(noise);
        stay_score[i] = stay;
        let mut best = (stay, Choice::Stay);
        for &r in &b.reach[i] {
            let x = r.province.0 as usize;
            if claimed[x] {
                continue;
            }
            let mut s = dest_score(b, v, me, u.kind, x, false) + rng.spread(noise);
            if let Some(w) = b.own_at(me, x) {
                match choice[w] {
                    Choice::Undecided => s -= 15,
                    Choice::Go(_) | Choice::Via { .. } => {}
                    _ => continue,
                }
            }
            if s > best.0 {
                best = (s, Choice::Go(r));
            }
        }
        if u.kind == UnitKind::Army && b.t.coastal[here] {
            for &f in &mine {
                let fu = b.unit(f);
                let sea = fu.province().0 as usize;
                if fu.kind != UnitKind::Fleet
                    || !b.t.sea[sea]
                    || choice[f] != Choice::Undecided
                    || !b.t.fleet[sea].contains(&here)
                {
                    continue;
                }
                for &x in &b.t.fleet[sea] {
                    if x == here
                        || !b.t.coastal[x]
                        || claimed[x]
                        || b.reach_bits[i].has(x)
                        || b.own_at(me, x).is_some()
                    {
                        continue;
                    }
                    // a convoy ties up a fleet: it has to be clearly worth it
                    let s = dest_score(b, v, me, u.kind, x, false) - 40 + rng.spread(noise);
                    if s > best.0 {
                        best = (s, Choice::Via { dest: x, fleet: f });
                    }
                }
            }
        }
        gain[i] = best.0 - stay;
        choice[i] = best.1;
        match best.1 {
            Choice::Go(r) => claimed[r.province.0 as usize] = true,
            Choice::Via { dest, fleet } => {
                claimed[dest] = true;
                choice[fleet] = Choice::Convoy { army: i, dest };
                claimed[b.unit(fleet).province().0 as usize] = true;
            }
            _ => claimed[here] = true,
        }
    }

    // --- supports ---
    let mut tasks: Vec<Task> = Vec::new();
    for &i in &mine {
        let u = b.unit(i);
        let here = u.province().0 as usize;
        match choice[i] {
            Choice::Go(_) | Choice::Via { .. } => {
                let x = match choice[i] {
                    Choice::Go(r) => r.province.0 as usize,
                    Choice::Via { dest, .. } => dest,
                    _ => unreachable!(),
                };
                let enemy = b.enemy_reach(me, x);
                let need = if b.foreign_at(me, x).is_some() {
                    1 + i32::from(enemy >= 2)
                } else {
                    i32::from(enemy >= 1)
                };
                if need > 0 {
                    tasks.push(Task {
                        target: i,
                        dest: Some(x),
                        need,
                        value: dest_score(b, v, me, u.kind, x, false),
                    });
                }
            }
            Choice::Stay => {
                let enemy = b.enemy_reach(me, here);
                let worth_guarding = b.t.sc[here] && (b.owner[here] == Some(me) || b.fall);
                let need = i32::from(enemy >= 2) + i32::from(enemy >= 3);
                if worth_guarding && need > 0 {
                    tasks.push(Task {
                        target: i,
                        dest: None,
                        need,
                        value: stay_score[i],
                    });
                }
            }
            _ => {}
        }
    }
    tasks.sort_by_key(|t| (std::cmp::Reverse(t.value), t.target));
    for task in &tasks {
        // the target may itself have been turned into a supporter by a richer task
        let still = match (choice[task.target], task.dest) {
            (Choice::Go(r), Some(x)) => r.province.0 as usize == x,
            (Choice::Via { dest, .. }, Some(x)) => dest == x,
            (Choice::Stay, None) => true,
            _ => false,
        };
        if !still {
            continue;
        }
        let area = task
            .dest
            .unwrap_or(b.unit(task.target).province().0 as usize);
        let mut helpers: Vec<(i32, usize)> = mine
            .iter()
            .copied()
            .filter(|&s| {
                s != task.target
                    && b.unit(s).province().0 as usize != area
                    && b.can_support(s, area)
                    && matches!(choice[s], Choice::Stay | Choice::Go(_))
            })
            .map(|s| {
                let cost = match choice[s] {
                    Choice::Go(_) => gain[s].max(0),
                    _ => 0,
                };
                (cost + rng.spread(noise), s)
            })
            .collect();
        helpers.sort();
        let mut need = task.need;
        for (cost, s) in helpers {
            if need <= 0 {
                break;
            }
            // giving up a move is only worth it for a clearly better prize
            if cost * 5 >= task.value * 3 {
                continue;
            }
            if let Choice::Go(r) = choice[s] {
                claimed[r.province.0 as usize] = false;
            }
            choice[s] = match task.dest {
                Some(x) => Choice::SupMove {
                    target: task.target,
                    dest: x,
                },
                None => Choice::SupHold(task.target),
            };
            need -= 1;
        }
    }

    // --- repairs: never walk into a friend who is not leaving ---
    for _ in 0..4 {
        let mut changed = false;
        for &i in &mine {
            let Choice::Go(r) = choice[i] else { continue };
            let x = r.province.0 as usize;
            let Some(w) = b.own_at(me, x) else { continue };
            let here = b.unit(i).province().0 as usize;
            let leaving = matches!(choice[w], Choice::Go(_) | Choice::Via { .. });
            let swap = matches!(choice[w], Choice::Go(rw) if rw.province.0 as usize == here);
            if leaving && !swap {
                continue;
            }
            choice[i] = if !leaving && b.can_support(i, x) {
                Choice::SupHold(w)
            } else {
                Choice::Stay
            };
            changed = true;
        }
        if !changed {
            break;
        }
    }

    mine.iter()
        .map(|&i| Order {
            power: me,
            unit: b.unit(i).province(),
            command: command(b, choice[i]),
        })
        .collect()
}
