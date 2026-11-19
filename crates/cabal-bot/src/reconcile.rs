//! Keeping one power's orders consistent with each other.
//!
//! The greedy prior and the search both change one unit at a time. A unit that
//! is turned from a mover into a supporter, or from a convoyed army into a
//! walker, leaves behind the orders that depended on it: a support for a move
//! nobody makes, a fleet convoying an army that is going elsewhere. Such orders
//! adjudicate as void, and they make the bot's own account of itself wrong.
//!
//! [`reconcile`] is the single place that puts a set right. It runs on every
//! order set the prior emits, on every set the search compares, and once more
//! on the final answer. It never asks the adjudicator anything and draws no
//! random numbers, so it costs nothing against the search budget.
//!
//! What it guarantees for the orders of `me`:
//!
//! - an army ordered "via convoy" has one of its own fleets, adjacent to both
//!   ends, ordered to carry it there; otherwise it walks (if it can) or holds;
//! - a fleet convoys only an army of its own that is ordered to that
//!   destination via convoy; otherwise it holds;
//! - no unit walks into one of its own that is not leaving, or swaps places
//!   with one head to head; it supports the unit in front instead, or holds;
//! - a support for one of its own units matches what that unit was ordered to
//!   do: it is re-pointed to the actual move or hold when the supporter can
//!   reach, and becomes a hold when it cannot.
//!
//! Orders that concern another power's units are left alone: the bot cannot
//! know what a foreign unit was ordered to do.

use cabal_engine::geo::{Power, ProvinceId, UnitKind};
use cabal_engine::order::{Command, Order};

use crate::board::Board;

/// Where an order sends its unit, if it is a move.
fn dest_of(c: Command) -> Option<usize> {
    match c {
        Command::Move { dest, .. } => Some(dest.0 as usize),
        _ => None,
    }
}

/// Make `orders` (all of them `me`'s, at most one per unit) agree with each
/// other. Returns how many orders it had to change.
pub(crate) fn reconcile(b: &Board, me: Power, orders: &mut [Order]) -> usize {
    let n = b.t.sc.len();
    // province -> index into `orders` of the order for the unit standing there
    let mut at: Vec<Option<usize>> = vec![None; n];
    for (k, o) in orders.iter().enumerate() {
        let x = o.unit.0 as usize;
        if o.power == me && x < n && b.own_at(me, x).is_some() {
            at[x] = Some(k);
        }
    }
    let unit_index = |o: &Order| b.own_at(me, o.unit.0 as usize);
    let mut changed = 0;

    // --- convoys: both halves or neither ---
    // an army is convoyed when it says so, or when it cannot get there on foot
    let sails = |orders: &[Order], k: usize, to: ProvinceId| -> bool {
        let Some(i) = b.own_at(me, orders[k].unit.0 as usize) else {
            return false;
        };
        match orders[k].command {
            Command::Move {
                dest, via_convoy, ..
            } => {
                dest == to
                    && b.unit(i).kind == UnitKind::Army
                    && (via_convoy || !b.reach_bits[i].has(dest.0 as usize))
            }
            _ => false,
        }
    };
    // A mover that becomes a stayer can strand a convoy, and a stranded army
    // can block a friend: go round until nothing changes. Every change turns a
    // move or a convoy into something that is neither, so this ends.
    for _ in 0..=2 * orders.len() {
        let before = changed;
        for k in 0..orders.len() {
            let Some(i) = unit_index(&orders[k]) else {
                continue;
            };
            let Command::Move { dest, .. } = orders[k].command else {
                continue;
            };
            if !sails(orders, k, dest) {
                continue;
            }
            let here = orders[k].unit.0 as usize;
            let x = dest.0 as usize;
            let army = orders[k].unit;
            let carried = x < n && orders.iter().any(|f| {
                let sea = f.unit.0 as usize;
                matches!(f.command, Command::Convoy { army: a, dest: d } if a == army && d == dest)
                    && b.own_at(me, sea)
                        .is_some_and(|w| b.unit(w).kind == UnitKind::Fleet)
                    && b.t.sea[sea]
                    && b.t.fleet[sea].contains(&here)
                    && b.t.fleet[sea].contains(&x)
            });
            if !carried {
                let direct = b.reach[i].iter().find(|r| r.province == dest);
                orders[k].command = match direct {
                    Some(&r) => crate::plan::move_to(b, r),
                    None => Command::Hold,
                };
                changed += 1;
            }
        }
        for k in 0..orders.len() {
            if unit_index(&orders[k]).is_none() {
                continue;
            }
            let Command::Convoy { army, dest } = orders[k].command else {
                continue;
            };
            let a = army.0 as usize;
            // a foreign army is none of our business: leave that convoy alone
            if a < n && b.foreign_at(me, a).is_some() {
                continue;
            }
            let wanted = a < n && at[a].is_some_and(|ka| sails(orders, ka, dest));
            if !wanted {
                orders[k].command = Command::Hold;
                changed += 1;
            }
        }

        // --- never walk into a friend who is not leaving, never swap head to head ---
        for _ in 0..orders.len() {
            let mut again = false;
            for k in 0..orders.len() {
                let Some(i) = unit_index(&orders[k]) else {
                    continue;
                };
                let Command::Move {
                    dest, via_convoy, ..
                } = orders[k].command
                else {
                    continue;
                };
                let x = dest.0 as usize;
                let here = orders[k].unit.0 as usize;
                let Some(kw) = at.get(x).copied().flatten() else {
                    continue;
                };
                let blocked = match orders[kw].command {
                    Command::Move {
                        dest: back,
                        via_convoy: theirs,
                        ..
                    } => back.0 as usize == here && !via_convoy && !theirs,
                    _ => true,
                };
                if !blocked {
                    continue;
                }
                let staying = dest_of(orders[kw].command).is_none();
                orders[k].command = if staying && b.can_support(i, x) {
                    Command::SupportHold { target: dest }
                } else {
                    Command::Hold
                };
                changed += 1;
                again = true;
            }
            if !again {
                break;
            }
        }

        if changed == before {
            break;
        }
    }

    // --- supports follow what the supported unit actually does ---
    for k in 0..orders.len() {
        let Some(i) = unit_index(&orders[k]) else {
            continue;
        };
        let here = orders[k].unit.0 as usize;
        let target = match orders[k].command {
            Command::SupportHold { target } | Command::SupportMove { target, .. } => target,
            _ => continue,
        };
        let t = target.0 as usize;
        let Some(kt) = at.get(t).copied().flatten() else {
            continue; // a foreign unit, or nobody: not ours to check
        };
        let actual = dest_of(orders[kt].command);
        let fixed = match actual {
            Some(x) if x != here && b.can_support(i, x) => Command::SupportMove {
                target,
                dest: ProvinceId(x as u8),
                coast: None,
            },
            Some(_) => Command::Hold,
            None if b.can_support(i, t) => Command::SupportHold { target },
            None => Command::Hold,
        };
        let same = match (orders[k].command, fixed) {
            (Command::SupportMove { dest: a, .. }, Command::SupportMove { dest: c, .. }) => a == c,
            (Command::SupportHold { .. }, Command::SupportHold { .. }) => true,
            _ => false,
        };
        if !same {
            orders[k].command = fixed;
            changed += 1;
        }
    }
    changed
}

/// The contradictions the reconcile pass removes, counted. Zero for every order set
/// the bot hands out; the tests and the arena hold it to that.
pub fn contradictions(orders: &[Order]) -> usize {
    let cmd = |x: ProvinceId| orders.iter().find(|o| o.unit == x).map(|o| o.command);
    orders
        .iter()
        .filter(|o| match o.command {
            Command::SupportHold { target } => {
                cmd(target).is_some_and(|c| dest_of(c).is_some())
            }
            Command::SupportMove { target, dest, .. } => {
                cmd(target).is_some_and(|c| dest_of(c) != Some(dest.0 as usize))
            }
            Command::Move {
                dest, via_convoy, ..
            } => {
                let stays = cmd(dest).is_some_and(|c| dest_of(c).is_none());
                let stranded = via_convoy
                    && !orders.iter().any(|f| {
                        matches!(f.command, Command::Convoy { army, dest: d } if army == o.unit && d == dest)
                    });
                stays || stranded
            }
            Command::Convoy { army, dest } => {
                cmd(army).is_some_and(|c| dest_of(c) != Some(dest.0 as usize))
            }
            Command::Hold => false,
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::tables;
    use cabal_engine::geo::Map;
    use cabal_engine::order::Unit;
    use cabal_engine::rulebook::Rulebook;
    use cabal_engine::state::Position;
    use cabal_engine::text::order_text;

    /// Units as `FRA A PAR`, orders in MILA text; returns the reconciled orders as text.
    fn fix(units: &[&str], orders: &[&str]) -> Vec<String> {
        let map = Map::standard();
        let mut pos = Position::default();
        for line in units {
            let p: Vec<&str> = line.split_whitespace().collect();
            pos.add_unit(Unit {
                power: map.find_power(p[0]).unwrap(),
                kind: if p[1] == "F" {
                    UnitKind::Fleet
                } else {
                    UnitKind::Army
                },
                region: map.parse_region(p[2]).unwrap(),
            });
        }
        let me = map
            .find_power(units[0].split_whitespace().next().unwrap())
            .unwrap();
        let t = tables(map);
        let b = Board::new(map, &t, &pos, Rulebook::default(), true);
        let mut parsed: Vec<Order> = orders
            .iter()
            .map(|text| {
                cabal_engine::parse::parse(map, text)
                    .ok()
                    .and_then(|p| p.to_movement(Some(me)).ok())
                    .unwrap_or_else(|| panic!("cannot read {text}"))
            })
            .collect();
        let changed = reconcile(&b, me, &mut parsed);
        let again = reconcile(&b, me, &mut parsed.clone());
        assert_eq!(again, 0, "reconcile must settle in one call");
        assert_eq!(contradictions(&parsed), 0);
        let out: Vec<String> = parsed.iter().map(|o| order_text(map, &pos, o)).collect();
        assert_eq!(
            changed == 0,
            out.iter().map(String::as_str).eq(orders.iter().copied()),
            "the change count must say whether anything changed: {out:?}"
        );
        out
    }

    #[test]
    fn a_support_follows_the_move_actually_ordered() {
        assert_eq!(
            fix(
                &["FRA A PAR", "FRA A MAR"],
                &["A PAR - BUR", "A MAR S A PAR - GAS"]
            ),
            ["A PAR - BUR", "A MAR S A PAR - BUR"]
        );
    }

    #[test]
    fn a_support_that_cannot_follow_becomes_a_hold() {
        assert_eq!(
            fix(
                &["FRA A PAR", "FRA F BRE"],
                &["A PAR - BUR", "F BRE S A PAR - PIC"]
            ),
            ["A PAR - BUR", "F BRE H"]
        );
    }

    #[test]
    fn a_support_for_a_mover_that_now_stays_becomes_support_to_hold() {
        assert_eq!(
            fix(
                &["FRA A PAR", "FRA A PIC", "FRA A GAS"],
                &[
                    "A PAR S A PIC - BUR",
                    "A PIC S A PAR",
                    "A GAS S A PAR - BUR"
                ]
            ),
            ["A PAR S A PIC", "A PIC S A PAR", "A GAS S A PAR"]
        );
    }

    #[test]
    fn support_to_hold_becomes_support_for_the_move() {
        assert_eq!(
            fix(
                &["FRA A PAR", "FRA A MAR"],
                &["A PAR - BUR", "A MAR S A PAR"]
            ),
            ["A PAR - BUR", "A MAR S A PAR - BUR"]
        );
    }

    #[test]
    fn a_convoy_without_its_army_holds() {
        assert_eq!(
            fix(
                &["ENG A YOR", "ENG F NTH"],
                &["A YOR - LON", "F NTH C A YOR - NWY"]
            ),
            ["A YOR - LON", "F NTH H"]
        );
    }

    #[test]
    fn an_army_without_its_convoy_holds_and_takes_its_supporter_with_it() {
        assert_eq!(
            fix(
                &["ENG A YOR", "ENG F NTH", "ENG F NWG"],
                &["A YOR - NWY VIA", "F NTH - HEL", "F NWG S A YOR - NWY"]
            ),
            ["A YOR H", "F NTH - HEL", "F NWG H"]
        );
    }

    #[test]
    fn a_complete_convoy_is_left_alone() {
        let orders = [
            "A YOR - NWY VIA",
            "F NTH C A YOR - NWY",
            "F NWG S A YOR - NWY",
        ];
        assert_eq!(
            fix(&["ENG A YOR", "ENG F NTH", "ENG F NWG"], &orders),
            orders
        );
    }

    #[test]
    fn nobody_walks_into_a_friend_who_stays_or_swaps_head_to_head() {
        assert_eq!(
            fix(
                &["FRA A BRE", "FRA A PAR", "FRA A BUR"],
                &["A BRE - PAR", "A PAR - BUR", "A BUR H"]
            ),
            ["A BRE S A PAR", "A PAR S A BUR", "A BUR H"]
        );
        assert_eq!(
            fix(&["FRA A PAR", "FRA A BUR"], &["A PAR - BUR", "A BUR - PAR"]),
            ["A PAR H", "A BUR S A PAR"]
        );
    }

    #[test]
    fn orders_about_foreign_units_are_not_second_guessed() {
        let orders = ["A PAR S A MUN - BUR", "A MAR S A MUN - BUR"];
        assert_eq!(
            fix(&["FRA A PAR", "FRA A MAR", "GER A MUN"], &orders[..]),
            orders
        );
    }
}
