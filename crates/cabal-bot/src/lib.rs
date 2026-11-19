//! Cabal's house player: a deterministic heuristic Diplomacy bot.
//!
//! No machine learning, no language model, no network. Given a game state, a
//! power, a seed and a [`Level`], [`decide`] returns one complete, legal order
//! set for the current phase (movement, retreat or adjustment) together with a
//! short machine-readable [`Intent`]: what it is going for, whom it supports
//! and whom it fears.
//!
//! How it plays movement phases:
//!
//! - a province value map per power, in the tradition of the DAIDE DumbBot;
//! - a greedy prior that turns the map into a full joint order set with
//!   supports and simple convoys;
//! - a sampled best-response search: candidate order sets are scored by
//!   adjudicating them with the real engine against order sets sampled for
//!   every nearby rival, inside a short regret-matching loop, followed by a
//!   unit-by-unit refinement.
//!
//! Guarantees, each enforced by tests:
//!
//! - **Deterministic.** Same state, power, seed and level: same decision, on
//!   any machine, natively and in WebAssembly. All scoring is integer and the
//!   compute budget is counted in adjudications, not time.
//! - **Legal and complete.** Exactly one legal order per unit; builds and
//!   disbands always fill the allowance (waiving explicitly when there is no
//!   free home centre). Every order is re-checked by the engine's own
//!   validator on the way out.
//! - **Never panics**, including on a power with no units or a state that does
//!   not belong to the map.

mod adjust;
mod board;
mod plan;
mod reconcile;
mod retreat;
mod rng;
mod search;
mod values;

use cabal_engine::geo::{Map, Power, ProvinceId};
use cabal_engine::legal::{legal_adjustments, legal_retreats};
use cabal_engine::order::{
    AdjustCommand, AdjustOrder, AnyOrder, Command, Order, RetreatCommand, RetreatOrder, normalise,
};
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::{GameState, PhaseKind, Season};
use serde::{Deserialize, Serialize};

use board::{Board, position_fits, tables};
pub use reconcile::contradictions;
use rng::{Rng, mix};

/// Playing strength.
#[derive(
    Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Default, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    /// The greedy plan with heavy noise and no lookahead.
    Easy,
    /// A small search: the default, sized to decide in a few milliseconds.
    #[default]
    Standard,
    /// More candidates, more rival samples, deeper refinement.
    Hard,
}

impl Level {
    pub const ALL: [Level; 3] = [Level::Easy, Level::Standard, Level::Hard];

    pub fn name(self) -> &'static str {
        match self {
            Level::Easy => "easy",
            Level::Standard => "standard",
            Level::Hard => "hard",
        }
    }

    pub fn parse(s: &str) -> Option<Level> {
        match s.trim().to_ascii_lowercase().as_str() {
            "easy" => Some(Level::Easy),
            "standard" | "normal" | "default" => Some(Level::Standard),
            "hard" => Some(Level::Hard),
            _ => None,
        }
    }

    /// Movement search parameters; `None` means no search at all.
    fn search(self) -> Option<search::Params> {
        match self {
            Level::Easy => None,
            Level::Standard => Some(search::Params {
                own: 6,
                rival: 2,
                iters: 3,
                worlds: 2,
                passes: 1,
                pairs: false,
                counter: 0,
                budget: 200,
                noise: 25,
            }),
            Level::Hard => Some(search::Params {
                own: 12,
                rival: 3,
                iters: 6,
                worlds: 2,
                passes: 2,
                pairs: true,
                counter: 2,
                budget: 3000,
                noise: 25,
            }),
        }
    }

    /// Jitter on retreat and adjustment scores, and on the easy level's one plan.
    fn noise(self) -> i32 {
        match self {
            Level::Easy => 90,
            Level::Standard => 8,
            Level::Hard => 0,
        }
    }
}

/// One support the bot ordered.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct SupportIntent {
    /// The supporting unit.
    pub unit: ProvinceId,
    /// The unit being supported.
    pub target: ProvinceId,
    /// Where the supported unit is going; `None` for support to hold.
    pub dest: Option<ProvinceId>,
    /// Who owns the supported unit.
    pub power: Power,
}

/// A rival the bot is worried about, with a rough size of the worry.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Fear {
    pub power: Power,
    /// Units of that power able to reach the bot's centres (counted twice) or units.
    pub threat: u32,
}

/// Why the bot ordered what it ordered, in a form press and the UI can use.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct Intent {
    /// Provinces the bot is trying to take or enter against opposition, best first.
    pub targets: Vec<ProvinceId>,
    /// Powers those targets belong to.
    pub against: Vec<Power>,
    /// Its own threatened centres it is standing on or supporting.
    pub defends: Vec<ProvinceId>,
    pub supports: Vec<SupportIntent>,
    /// Rivals in reach of its centres and units, most dangerous first.
    pub fears: Vec<Fear>,
    /// Candidate order sets compared (movement only).
    pub candidates: u32,
    /// Adjudications spent on the decision (movement only).
    pub adjudications: u32,
    /// Orders the planner proposed that the engine's validator refused, and
    /// that were replaced by holds. Always zero unless the planner has a bug.
    #[serde(default)]
    pub rejected: u32,
}

/// A full order set for one power in the current phase.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct Decision {
    pub orders: Vec<AnyOrder>,
    pub intent: Intent,
}

/// Turn any text (a game id, say) into a seed. FNV-1a, stable forever.
pub fn seed_from_str(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in s.bytes() {
        h ^= u64::from(byte);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Decide `power`'s orders for the phase `state` is in.
///
/// One `seed` can serve a whole game: it is mixed with the phase and the power,
/// so every decision draws from its own stream.
pub fn decide(
    map: &Map,
    rulebook: Rulebook,
    state: &GameState,
    power: Power,
    seed: u64,
    level: Level,
) -> Decision {
    if power.0 as usize >= map.powers().len() || !position_fits(map, &state.position) {
        return Decision::default();
    }
    let phase = state.phase;
    let stamp = (u64::from(phase.year) << 8)
        | (phase.season as u64) << 4
        | (phase.kind as u64) << 2
        | level as u64;
    let mut rng = Rng::new(mix(mix(seed, stamp), u64::from(power.0)));
    let t = tables(map);
    let fall = phase.season != Season::Spring;
    let b = Board::new(map, &t, &state.position, rulebook, fall);

    let mut intent = Intent {
        fears: fears(&b, power),
        ..Intent::default()
    };
    let orders = match phase.kind {
        PhaseKind::Movement => {
            let picked = if b.units_of(power).is_empty() {
                Vec::new()
            } else {
                match level.search() {
                    Some(params) => {
                        let found = search::movement(&b, power, &mut rng, params);
                        intent.candidates = found.candidates as u32;
                        intent.adjudications = found.adjudications;
                        found.orders
                    }
                    None => {
                        intent.candidates = 1;
                        let v = values::compute(&b, power);
                        plan::sample(&b, &v, power, &mut rng, level.noise())
                    }
                }
            };
            let (orders, rejected) = checked_movement(&b, power, picked);
            intent.rejected = rejected;
            describe_movement(&b, power, &orders, &mut intent);
            orders.into_iter().map(AnyOrder::Movement).collect()
        }
        PhaseKind::Retreat => {
            let dislodged: Vec<usize> = state
                .dislodged
                .iter()
                .map(|d| d.unit.province().0 as usize)
                .collect();
            let sane = dislodged.iter().all(|&x| x < map.provinces().len())
                && state
                    .dislodged
                    .iter()
                    .all(|d| (d.attacker_from.0 as usize) < map.provinces().len());
            let picked = if sane {
                let v = values::compute(&b, power);
                retreat::decide(&b, &v, state, power, &mut rng, level.noise())
            } else {
                Vec::new()
            };
            let orders = if sane {
                checked_retreats(map, state, power, picked)
            } else {
                Vec::new()
            };
            for o in &orders {
                if let RetreatCommand::Retreat { dest, .. } = o.command {
                    intent.targets.push(dest);
                }
            }
            orders.into_iter().map(AnyOrder::Retreat).collect()
        }
        PhaseKind::Adjustment => {
            let v = values::compute_spring(&b, power);
            let picked = adjust::decide(&b, &v, power, &mut rng, level.noise());
            checked_adjustments(&b, power, picked)
                .into_iter()
                .map(AnyOrder::Adjustment)
                .collect()
        }
    };
    Decision { orders, intent }
}

/// Exactly one engine-approved order per unit, in board order, and no order
/// that contradicts another of the same power (see [`reconcile`]).
///
/// Returns the orders and how many of them the engine's validator rejected and
/// the bot replaced with a hold. That count is a planner bug detector: it has
/// been zero in every game ever played, and the tests and the arena assert it.
fn checked_movement(b: &Board, me: Power, picked: Vec<Order>) -> (Vec<Order>, u32) {
    let mut rejected = 0u32;
    let mut orders: Vec<Order> = b
        .units_of(me)
        .into_iter()
        .map(|i| {
            let unit = b.unit(i).province();
            let mut wanted = picked.iter().filter(|o| o.unit == unit && o.power == me);
            match (wanted.next(), wanted.next()) {
                (Some(&o), None) => o,
                _ => {
                    rejected += 1;
                    Order {
                        power: me,
                        unit,
                        command: Command::Hold,
                    }
                }
            }
        })
        .collect();
    // Validate, then reconcile; a reconciled order is validated again. The
    // loop stops on a set that is both legal and consistent; should it ever run
    // out of rounds, the last word below belongs to the validator.
    for _ in 0..=orders.len() {
        let mut dirty = false;
        for o in orders.iter_mut() {
            match normalise(b.map, b.pos, *o) {
                Ok(n) => *o = n,
                Err(_) => {
                    o.command = Command::Hold;
                    rejected += 1;
                    dirty = true;
                }
            }
        }
        if reconcile::reconcile(b, me, &mut orders) == 0 && !dirty {
            break;
        }
    }
    for o in orders.iter_mut() {
        if normalise(b.map, b.pos, *o).is_err() {
            o.command = Command::Hold;
            rejected += 1;
        }
    }
    (orders, rejected)
}

/// One legal retreat order per dislodged unit; two of our own never share a destination.
fn checked_retreats(
    map: &Map,
    state: &GameState,
    me: Power,
    picked: Vec<RetreatOrder>,
) -> Vec<RetreatOrder> {
    let mut taken: Vec<ProvinceId> = Vec::new();
    legal_retreats(map, state, me)
        .into_iter()
        .map(|(unit, legal)| {
            let disband = RetreatOrder {
                power: me,
                unit,
                command: RetreatCommand::Disband,
            };
            let mut wanted = picked.iter().filter(|o| o.unit == unit);
            let order = match (wanted.next(), wanted.next()) {
                (Some(o), None) if legal.contains(o) => *o,
                _ => disband,
            };
            match order.command {
                RetreatCommand::Retreat { dest, .. } if taken.contains(&dest) => disband,
                RetreatCommand::Retreat { dest, .. } => {
                    taken.push(dest);
                    order
                }
                RetreatCommand::Disband => order,
            }
        })
        .collect()
}

/// Exactly `|allowance|` legal orders: distinct builds topped up with waives, or distinct disbands.
fn checked_adjustments(b: &Board, me: Power, picked: Vec<AdjustOrder>) -> Vec<AdjustOrder> {
    let (delta, legal) = legal_adjustments(b.map, b.pos, b.rulebook, me);
    let want = delta.unsigned_abs() as usize;
    let mut out: Vec<AdjustOrder> = Vec::with_capacity(want);
    let mut used: Vec<ProvinceId> = Vec::new();
    if delta > 0 {
        for o in picked {
            if out.len() == want {
                break;
            }
            match o.command {
                AdjustCommand::Build { region, .. }
                    if legal.contains(&o) && !used.contains(&region.province) =>
                {
                    used.push(region.province);
                    out.push(o);
                }
                _ => {}
            }
        }
        while out.len() < want {
            out.push(AdjustOrder {
                power: me,
                command: AdjustCommand::Waive,
            });
        }
    } else if delta < 0 {
        let fallback = legal.iter().copied();
        for o in picked.into_iter().chain(fallback) {
            if out.len() == want {
                break;
            }
            match o.command {
                AdjustCommand::Disband { unit } if legal.contains(&o) && !used.contains(&unit) => {
                    used.push(unit);
                    out.push(o);
                }
                _ => {}
            }
        }
    }
    out
}

fn fears(b: &Board, me: Power) -> Vec<Fear> {
    let mut out: Vec<Fear> = b
        .map
        .power_ids()
        .filter(|&q| q != me)
        .map(|q| {
            let near = &b.pressure[q.0 as usize];
            let mut threat = 0u32;
            for &c in &b.t.centres {
                if b.owner[c] == Some(me) {
                    threat += 2 * u32::from(near[c]);
                }
            }
            for u in b.pos.units.iter().filter(|u| u.power == me) {
                threat += u32::from(near[u.province().0 as usize]);
            }
            Fear { power: q, threat }
        })
        .filter(|f| f.threat > 0)
        .collect();
    out.sort_by_key(|f| (std::cmp::Reverse(f.threat), f.power.0));
    out
}

fn describe_movement(b: &Board, me: Power, orders: &[Order], intent: &mut Intent) {
    let mut targets: Vec<(i32, usize)> = Vec::new();
    let mut against: Vec<Power> = Vec::new();
    let mut defends: Vec<ProvinceId> = Vec::new();
    let threatened = |x: usize| b.t.sc[x] && b.owner[x] == Some(me) && b.enemy_reach(me, x) > 0;
    for o in orders {
        let here = o.unit.0 as usize;
        match o.command {
            Command::Move { dest, .. } => {
                let x = dest.0 as usize;
                let occupant = b.foreign_at(me, x).map(|i| b.unit(i).power);
                if b.prize(me, x) || occupant.is_some() {
                    let worth = if b.t.sc[x] { 1000 } else { 0 } + i32::from(b.total_pressure[x]);
                    targets.push((worth, x));
                    for q in b.owner[x].into_iter().chain(occupant) {
                        if q != me && !against.contains(&q) {
                            against.push(q);
                        }
                    }
                }
            }
            Command::SupportHold { target } | Command::SupportMove { target, .. } => {
                let dest = match o.command {
                    Command::SupportMove { dest, .. } => Some(dest),
                    _ => None,
                };
                let Some(i) = b.occ[target.0 as usize] else {
                    continue;
                };
                // Report a support only if it is real: the supported unit, when
                // it is ours, was ordered to do exactly what is being supported.
                let theirs = orders.iter().find(|q| q.unit == target).map(|q| q.command);
                let real = match (theirs, dest) {
                    (None, _) => true,
                    (Some(Command::Move { dest: d, .. }), Some(x)) => d == x,
                    (Some(Command::Move { .. }), None) => false,
                    (Some(_), d) => d.is_none(),
                };
                if !real {
                    continue;
                }
                intent.supports.push(SupportIntent {
                    unit: o.unit,
                    target,
                    dest,
                    power: b.unit(i).power,
                });
                let guarded = target.0 as usize;
                if dest.is_none() && threatened(guarded) && !defends.contains(&target) {
                    defends.push(target);
                }
                if threatened(here) && !defends.contains(&o.unit) {
                    defends.push(o.unit);
                }
            }
            Command::Hold | Command::Convoy { .. } => {
                if threatened(here) && !defends.contains(&o.unit) {
                    defends.push(o.unit);
                }
            }
        }
    }
    targets.sort_by_key(|&(worth, x)| (std::cmp::Reverse(worth), x));
    targets.dedup_by_key(|t| t.1);
    intent.targets = targets
        .into_iter()
        .map(|(_, x)| ProvinceId(x as u8))
        .collect();
    against.sort_by_key(|q| q.0);
    defends.sort();
    intent.against = against;
    intent.defends = defends;
}
