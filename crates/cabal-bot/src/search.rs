//! The search: candidates are judged by *playing them out* on the real adjudicator.
//!
//! 1. Every power gets a handful of candidate joint order sets from the greedy
//!    prior ([`crate::plan`]). Powers too far away to matter get exactly one.
//! 2. A short regret-matching loop (as in SearchBot, without the neural network)
//!    lets the bot and its nearby rivals adapt to each other: each iteration
//!    samples one candidate per power from its current policy, adjudicates every
//!    alternative of every searching power against that sample, and accumulates
//!    regret. The bot ends up with the candidate that scored best on average
//!    against rivals who were themselves learning to answer it.
//! 3. Coordinate ascent then repairs that candidate one unit (or one
//!    attacker-supporter pair) at a time against the last sampled rival worlds,
//!    keeping a change only when adjudication says it is strictly better.
//! 4. At the hard level, counter-play: each nearby rival in turn best-responds
//!    (by the same coordinate ascent) to the orders the bot has settled on, the
//!    resulting board becomes one more world, and the bot refines again. This is
//!    iterated best response, and it is what makes the bot guard against the
//!    supported attack it would itself launch from the other side.
//!
//! Everything is counted in adjudications, never in wall-clock time, so a seed
//! reproduces the same decision on any machine.

use cabal_engine::adjudicate::movement::{MovementResult, resolve_movement};
use cabal_engine::geo::Power;
use cabal_engine::order::{Command, Order};

use crate::board::{Bits, Board};
use crate::plan::{dest_score, move_to, sample};
use crate::rng::Rng;
use crate::values::{self, Values};

/// Taking a centre in Fall.
const CAPTURE: i64 = 1000;
/// An enemy ending Fall on one of our centres (a home centre costs 150 more).
const LOSS: i64 = 1000;
const DISLODGED: i64 = 320;
/// Dislodging somebody else's unit.
const KILL: i64 = 140;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Params {
    /// Candidate order sets for the deciding power.
    pub own: usize,
    /// Candidate order sets per nearby rival.
    pub rival: usize,
    /// Regret-matching iterations.
    pub iters: usize,
    /// Rival worlds the refinement averages over.
    pub worlds: usize,
    /// Coordinate ascent sweeps over the bot's units.
    pub passes: usize,
    /// Try attacker plus supporter as one change.
    pub pairs: bool,
    /// Rounds of counter-play: every nearby rival best-responds to the bot's
    /// current orders, that reply becomes one more world, and the bot refines again.
    pub counter: usize,
    /// Hard cap on adjudications for one decision.
    pub budget: u32,
    /// Jitter step between successive prior samples.
    pub noise: i32,
}

pub(crate) struct Found {
    pub orders: Vec<Order>,
    pub adjudications: u32,
    pub candidates: usize,
}

/// How good a resolved movement phase is for `me`: where its units ended up on
/// its value map, what changed hands (Fall only), the forecast for every supply
/// centre next turn, and who was dislodged.
pub(crate) fn eval(b: &Board, v: &Values, me: Power, r: &MovementResult) -> i64 {
    let mut s = 0i64;
    for u in &r.position.units {
        let x = u.province().0 as usize;
        if u.power == me {
            s += i64::from(v.of(u.kind, x));
            if b.fall && b.prize(me, x) {
                s += CAPTURE;
            }
        } else if b.fall && b.t.sc[x] && b.owner[x] == Some(me) {
            s -= LOSS;
            if b.t.home[x] == Some(me) {
                s -= 150;
            }
        }
    }
    let ahead = outlook(b, me, r);
    s += if b.fall { ahead * 3 / 10 } else { ahead };
    for d in &r.dislodged {
        if d.unit.power == me {
            s -= DISLODGED;
        } else if b.own_at(me, d.attacker_from.0 as usize).is_some() {
            s += KILL;
        }
    }
    s
}

/// A static exchange count on every supply centre for the turn *after* this one:
/// who stands there, how many of mine can reach it, how many of the strongest
/// rival's can. In Spring this is the forecast of the Fall count.
fn outlook(b: &Board, me: Power, r: &MovementResult) -> i64 {
    let n = b.t.sc.len();
    let np = b.centres.len();
    let m = me.0 as usize;
    let mut reach = vec![0u8; np * n];
    let mut stand = vec![u8::MAX; n];
    for u in &r.position.units {
        let x = u.province().0 as usize;
        let q = u.power.0 as usize;
        stand[x] = u.power.0;
        for &y in &b.t.of(u.kind)[x] {
            reach[q * n + y] += 1;
        }
    }
    let mut s = 0i64;
    for &c in &b.t.centres {
        let mine = i64::from(reach[m * n + c]);
        let rival = (0..np)
            .filter(|&q| q != m)
            .map(|q| i64::from(reach[q * n + c]))
            .max()
            .unwrap_or(0);
        let holder = stand[c];
        // in Fall, whoever stands on a centre now owns it for the forecast
        let owned = if holder == me.0 {
            b.fall || b.owner[c] == Some(me)
        } else if holder != u8::MAX && b.fall {
            false
        } else {
            b.owner[c] == Some(me)
        };
        if owned {
            if holder == me.0 {
                if rival > 1 + mine {
                    s -= 300;
                }
            } else if holder == u8::MAX {
                if rival > mine {
                    s -= 450;
                } else if rival > 0 && rival == mine {
                    s -= 150;
                }
            } else {
                let hold = 1 + i64::from(reach[holder as usize * n + c]);
                s -= if mine > hold { 250 } else { 650 };
            }
        } else if holder == me.0 {
            s += if rival > 1 + mine { 350 } else { 700 };
        } else if holder == u8::MAX {
            if mine > rival {
                s += 420;
            } else if mine > 0 && mine == rival {
                s += 160;
            } else if mine > 0 {
                s += 60;
            }
        } else {
            let hold = 1 + i64::from(reach[holder as usize * n + c]);
            if mine > hold {
                s += 380;
            } else if mine > 0 && mine == hold {
                s += 90;
            } else if mine > 0 {
                s += 30;
            }
        }
    }
    s
}

struct Arena<'a, 'b> {
    b: &'a Board<'b>,
    budget: u32,
    used: u32,
    scratch: Vec<Order>,
}

impl Arena<'_, '_> {
    fn left(&self) -> u32 {
        self.budget.saturating_sub(self.used)
    }

    /// Adjudicate the concatenation of the given order sets.
    fn play(&mut self, sets: &[&[Order]]) -> MovementResult {
        self.used += 1;
        self.scratch.clear();
        for s in sets {
            self.scratch.extend_from_slice(s);
        }
        resolve_movement(self.b.map, self.b.pos, self.b.rulebook, &self.scratch)
    }
}

/// Powers whose units or centres are close enough to interact with `me` this year.
fn rivals(b: &Board, me: Power) -> Vec<Power> {
    let n = b.t.sc.len();
    let grow = |seed: &Bits| {
        let mut out = *seed;
        for _ in 0..2 {
            let prev = out;
            for x in 0..n {
                if prev.has(x) {
                    for &y in &b.t.any[x] {
                        out.set(y);
                    }
                }
            }
        }
        out
    };
    let mut my_units = Bits::default();
    let mut my_land = Bits::default();
    for u in b.pos.units.iter().filter(|u| u.power == me) {
        my_units.set(u.province().0 as usize);
        my_land.set(u.province().0 as usize);
    }
    for &c in &b.t.centres {
        if b.owner[c] == Some(me) {
            my_land.set(c);
        }
    }
    let near_me = grow(&my_land);
    let near_units = grow(&my_units);
    let mut out = Vec::new();
    for q in b.map.power_ids().filter(|&q| q != me) {
        let unit_close = b
            .pos
            .units
            .iter()
            .any(|u| u.power == q && near_me.has(u.province().0 as usize));
        let centre_close =
            b.t.centres
                .iter()
                .any(|&c| b.owner[c] == Some(q) && near_units.has(c));
        let has_units = b.pos.units.iter().any(|u| u.power == q);
        if has_units && (unit_close || centre_close) {
            out.push(q);
        }
    }
    out
}

/// Up to `count` distinct prior samples; the first is always the noise-free greedy plan.
/// With a `hostile` map, the second is the greedy plan of a power bent on attacking
/// the searcher, so that the threats a rival *could* make are always on the table.
fn candidates(
    b: &Board,
    v: &Values,
    hostile: Option<&Values>,
    q: Power,
    rng: &mut Rng,
    count: usize,
    noise: i32,
) -> Vec<Vec<Order>> {
    let mut out: Vec<Vec<Order>> = Vec::with_capacity(count);
    out.push(sample(b, v, q, rng, 0));
    if let Some(h) = hostile.filter(|_| count > 1) {
        let c = sample(b, h, q, rng, 0);
        if !out.contains(&c) {
            out.push(c);
        }
    }
    let mut step = 1;
    while out.len() < count && step < count * 2 {
        let c = sample(b, v, q, rng, noise * step as i32);
        if !out.contains(&c) {
            out.push(c);
        }
        step += 1;
    }
    out
}

/// Regret matching: play in proportion to positive regret, uniformly when there is none.
fn pick(regret: &[i64], rng: &mut Rng) -> usize {
    let total: i64 = regret.iter().map(|&r| r.max(0)).sum();
    if total <= 0 {
        return rng.below(regret.len() as u32) as usize;
    }
    // scores stay far below 2^31 per adjudication and iterations are few
    let mut roll = (rng.next() % total as u64) as i64;
    for (i, &r) in regret.iter().enumerate() {
        roll -= r.max(0);
        if roll < 0 {
            return i;
        }
    }
    regret.len() - 1
}

pub(crate) fn movement(b: &Board, me: Power, rng: &mut Rng, p: Params) -> Found {
    let powers: Vec<Power> = b
        .map
        .power_ids()
        .filter(|&q| b.pos.units.iter().any(|u| u.power == q))
        .collect();
    let near = rivals(b, me);
    let vals: Vec<Option<Values>> = b
        .map
        .power_ids()
        .map(|q| powers.contains(&q).then(|| values::compute(b, q)))
        .collect();
    let val = |q: Power| vals[q.0 as usize].as_ref().expect("power has units");

    // candidate sets, indexed like `powers`
    let cands: Vec<Vec<Vec<Order>>> = powers
        .iter()
        .map(|&q| {
            let (count, hostile) = if q == me {
                (p.own, None)
            } else if near.contains(&q) {
                (p.rival, Some(values::compute_hostile(b, q, me)))
            } else {
                (1, None)
            };
            candidates(b, val(q), hostile.as_ref(), q, rng, count.max(1), p.noise)
        })
        .collect();
    let me_at = powers
        .iter()
        .position(|&q| q == me)
        .expect("caller checked units");
    let own = &cands[me_at];
    let mut arena = Arena {
        b,
        budget: p.budget,
        used: 0,
        scratch: Vec::with_capacity(b.pos.units.len()),
    };

    // --- regret matching ---
    let searching: Vec<usize> = (0..powers.len()).filter(|&k| cands[k].len() > 1).collect();
    let mut regret: Vec<Vec<i64>> = cands.iter().map(|c| vec![0; c.len()]).collect();
    let mut mean = vec![0i64; own.len()];
    let mut cur = vec![0usize; powers.len()];
    let mut worlds: Vec<Vec<usize>> = Vec::new();
    let per_iter = searching
        .iter()
        .map(|&k| cands[k].len() as u32)
        .sum::<u32>();
    if own.len() > 1 || searching.len() > 1 {
        for it in 0..p.iters {
            if arena.left() < per_iter.max(1) {
                break;
            }
            if it > 0 {
                for &k in &searching {
                    cur[k] = pick(&regret[k], rng);
                }
            }
            let sets = |cur: &[usize]| -> Vec<&[Order]> {
                (0..powers.len())
                    .map(|k| cands[k][cur[k]].as_slice())
                    .collect()
            };
            // the sampled profile itself gives every power its baseline
            let played = arena.play(&sets(&cur));
            let baseline: Vec<i64> = powers
                .iter()
                .map(|&q| eval(b, val(q), q, &played))
                .collect();
            for &k in &searching {
                let q = powers[k];
                let mut trial = cur.clone();
                for j in 0..cands[k].len() {
                    let u = if j == cur[k] {
                        baseline[k]
                    } else {
                        trial[k] = j;
                        let r = arena.play(&sets(&trial));
                        eval(b, val(q), q, &r)
                    };
                    regret[k][j] += u - baseline[k];
                    if k == me_at {
                        mean[j] += u;
                    }
                }
            }
            worlds.push(cur.clone());
        }
    }
    let mut best = 0;
    for j in 1..own.len() {
        if mean[j] > mean[best] {
            best = j;
        }
    }

    // --- refinement worlds: the most recent distinct rival samples ---
    let mut picks: Vec<Vec<usize>> = Vec::new();
    for w in worlds.iter().rev() {
        let mut w = w.clone();
        w[me_at] = 0;
        if !picks.contains(&w) {
            picks.push(w);
        }
        if picks.len() >= p.worlds.max(1) {
            break;
        }
    }
    if picks.is_empty() {
        picks.push(vec![0; powers.len()]);
    }
    // per world, one order set per power (indexed like `powers`)
    let world_sets: Vec<Vec<Vec<Order>>> = picks
        .iter()
        .map(|w| (0..powers.len()).map(|k| cands[k][w[k]].clone()).collect())
        .collect();
    let flatten = |sets: &[Vec<Order>], skip: usize| -> Vec<Order> {
        sets.iter()
            .enumerate()
            .filter(|&(k, _)| k != skip)
            .flat_map(|(_, s)| s.iter().copied())
            .collect()
    };
    let mut others: Vec<Vec<Order>> = world_sets.iter().map(|w| flatten(w, me_at)).collect();

    let mut orders = own[best].clone();
    if p.passes > 0 {
        refine(
            b,
            me,
            val(me),
            &others,
            &mut orders,
            &mut arena,
            p.passes,
            p.pairs,
            rng,
        );
    }

    // --- counter-play: what if they see this coming? ---
    let mut latest = world_sets[0].clone();
    for _ in 0..p.counter {
        if arena.left() == 0 {
            break;
        }
        latest[me_at] = orders.clone();
        for (k, &q) in powers.iter().enumerate() {
            if k == me_at || !near.contains(&q) {
                continue;
            }
            let fixed = flatten(&latest, k);
            let mut theirs = latest[k].clone();
            refine(
                b,
                q,
                val(q),
                std::slice::from_ref(&fixed),
                &mut theirs,
                &mut arena,
                1,
                p.pairs,
                rng,
            );
            latest[k] = theirs;
        }
        let reply = flatten(&latest, me_at);
        if others.contains(&reply) {
            break; // nobody found a better answer: the plan is stable
        }
        others.push(reply);
        refine(
            b,
            me,
            val(me),
            &others,
            &mut orders,
            &mut arena,
            p.passes.max(1),
            p.pairs,
            rng,
        );
    }
    Found {
        orders,
        adjudications: arena.used,
        candidates: own.len(),
    }
}

/// One proposed edit: new commands for one or two of the bot's units (by index into its orders).
type Edit = [(usize, Command); 2];

#[allow(clippy::too_many_arguments)]
fn refine(
    b: &Board,
    me: Power,
    v: &Values,
    others: &[Vec<Order>],
    orders: &mut [Order],
    arena: &mut Arena,
    passes: usize,
    pairs: bool,
    rng: &mut Rng,
) {
    let mine = b.units_of(me);
    debug_assert_eq!(mine.len(), orders.len());
    let cost = others.len() as u32;
    let total = |arena: &mut Arena, orders: &[Order]| -> i64 {
        others
            .iter()
            .map(|w| {
                let r = arena.play(&[orders, w]);
                eval(b, v, me, &r)
            })
            .sum()
    };
    if arena.left() < cost {
        return;
    }
    let mut score = total(arena, orders);

    // units in contact with the enemy first: that is where a wrong order costs most
    let mut sweep: Vec<usize> = (0..mine.len()).collect();
    rng.shuffle(&mut sweep);
    sweep.sort_by_key(|&k| {
        let i = mine[k];
        let here = b.unit(i).province().0 as usize;
        let contact = b.enemy_reach(me, here)
            + b.reach[i]
                .iter()
                .filter(|r| b.foreign_at(me, r.province.0 as usize).is_some())
                .count() as i32;
        std::cmp::Reverse(contact)
    });

    for _ in 0..passes {
        let mut improved = false;
        for &k in &sweep {
            let mut best: Option<(i64, Edit)> = None;
            for edit in edits(b, me, v, &mine, orders, k, pairs) {
                if arena.left() < cost {
                    break;
                }
                let before = [orders[edit[0].0].command, orders[edit[1].0].command];
                orders[edit[0].0].command = edit[0].1;
                orders[edit[1].0].command = edit[1].1;
                let s = total(arena, orders);
                orders[edit[1].0].command = before[1];
                orders[edit[0].0].command = before[0];
                if s > best.map_or(score, |(bs, _)| bs) {
                    best = Some((s, edit));
                }
            }
            if let Some((s, edit)) = best {
                orders[edit[0].0].command = edit[0].1;
                orders[edit[1].0].command = edit[1].1;
                score = s;
                improved = true;
            }
            if arena.left() < cost {
                return;
            }
        }
        if !improved {
            break;
        }
    }
}

/// Alternatives for the unit at `orders[k]`, most promising first.
fn edits(
    b: &Board,
    me: Power,
    v: &Values,
    mine: &[usize],
    orders: &[Order],
    k: usize,
    pairs: bool,
) -> Vec<Edit> {
    let i = mine[k];
    let u = b.unit(i);
    let here = u.province().0 as usize;
    let current = orders[k].command;
    let solo = |c: Command| -> Edit { [(k, c), (k, c)] };
    let mut out: Vec<(i32, Edit)> = Vec::new();

    let moving_to = |c: Command| match c {
        Command::Move { dest, .. } => Some(dest.0 as usize),
        _ => None,
    };

    if current != Command::Hold {
        out.push((
            dest_score(b, v, me, u.kind, here, true),
            solo(Command::Hold),
        ));
    }
    for &r in &b.reach[i] {
        let x = r.province.0 as usize;
        let c = move_to(b, r);
        // a friend who is staying put blocks the square
        let blocked = mine
            .iter()
            .position(|&w| b.unit(w).province().0 as usize == x)
            .is_some_and(|kw| moving_to(orders[kw].command).is_none());
        if blocked {
            continue;
        }
        let worth = dest_score(b, v, me, u.kind, x, false);
        if c != current {
            out.push((worth, solo(c)));
        }
        if pairs && (b.foreign_at(me, x).is_some() || b.enemy_reach(me, x) > 0) {
            for (kw, &w) in mine.iter().enumerate() {
                if kw == k || b.unit(w).province().0 as usize == x || !b.can_support(w, x) {
                    continue;
                }
                let s = Command::SupportMove {
                    target: u.province(),
                    dest: r.province,
                    coast: None,
                };
                if orders[kw].command == s && c == current {
                    continue;
                }
                out.push((worth + 40, [(k, c), (kw, s)]));
            }
        }
    }
    for (kw, &w) in mine.iter().enumerate() {
        if kw == k {
            continue;
        }
        let there = b.unit(w).province().0 as usize;
        let c = match moving_to(orders[kw].command) {
            Some(x) if x != here && b.can_support(i, x) => Command::SupportMove {
                target: b.unit(w).province(),
                dest: cabal_engine::ProvinceId(x as u8),
                coast: None,
            },
            None if b.can_support(i, there) => Command::SupportHold {
                target: b.unit(w).province(),
            },
            _ => continue,
        };
        if c != current {
            let x = moving_to(orders[kw].command).unwrap_or(there);
            out.push((v.of(b.unit(w).kind, x) + 20, solo(c)));
        }
    }
    out.sort_by_key(|&(worth, _)| std::cmp::Reverse(worth));
    out.into_iter().map(|(_, e)| e).collect()
}
