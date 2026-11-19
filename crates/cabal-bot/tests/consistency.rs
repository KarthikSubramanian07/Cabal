//! A power's orders must agree with each other, and the bot's account of them
//! (`intent.supports`) must describe supports that are really happening.
//!
//! Before the reconcile pass existed, this test found 504 self-contradicting
//! orders in these same 27 games: at the default level one support-move in five
//! backed a move its own power had not ordered, and one convoyed army in ten
//! had no fleet carrying it.

mod common;

use std::collections::BTreeMap;

use cabal_bot::{Level, contradictions, decide};
use cabal_engine::order::{AnyOrder, Command, Order};
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::PhaseKind;
use cabal_engine::{Game, Status};
use common::{assert_consistent, map};

fn dest_of(c: Command) -> Option<cabal_engine::ProvinceId> {
    match c {
        Command::Move { dest, .. } => Some(dest),
        _ => None,
    }
}

#[test]
fn a_power_does_not_contradict_its_own_orders() {
    let map = map();
    // (kind of order, level) -> (seen, contradicting)
    let mut tally: BTreeMap<(&'static str, &'static str), (u64, u64)> = BTreeMap::new();
    let mut first: BTreeMap<&'static str, String> = BTreeMap::new();
    for (level, games, until) in [
        (Level::Easy, 12u64, 1908u16),
        (Level::Standard, 12, 1908),
        (Level::Hard, 3, 1906),
    ] {
        for seed in 0..games {
            let mut game = Game::new(map, Rulebook::default());
            while game.status == Status::Active && game.phase().year <= until {
                let mut all: Vec<AnyOrder> = Vec::new();
                for p in map.power_ids() {
                    let d = decide(map, game.rulebook, &game.state, p, seed, level);
                    if game.phase().kind == PhaseKind::Movement {
                        let what = format!(
                            "{} seed {seed} {} {}",
                            level.name(),
                            game.phase(),
                            map.power(p).code
                        );
                        let mine: Vec<Order> = d
                            .orders
                            .iter()
                            .filter_map(|o| match o {
                                AnyOrder::Movement(o) => Some(*o),
                                _ => None,
                            })
                            .collect();
                        let cmd = |x| mine.iter().find(|o| o.unit == x).map(|o| o.command);
                        let mut note = |kind: &'static str, bad: bool, o: &Order| {
                            let e = tally.entry((kind, level.name())).or_default();
                            e.0 += 1;
                            if bad {
                                e.1 += 1;
                                first
                                    .entry(kind)
                                    .or_insert_with(|| format!("{what}: {o:?} in {mine:?}"));
                            }
                        };
                        for o in &mine {
                            match o.command {
                                Command::SupportHold { target } => {
                                    let bad = cmd(target).and_then(dest_of).is_some();
                                    note("support-to-hold for its own mover", bad, o);
                                }
                                Command::SupportMove { target, dest, .. } => {
                                    let bad = cmd(target).and_then(dest_of) != Some(dest);
                                    note("support for a move not ordered", bad, o);
                                }
                                Command::Move {
                                    dest, via_convoy, ..
                                } => {
                                    let blocked = cmd(dest).is_some_and(|c| dest_of(c).is_none());
                                    note("move into its own unit that stays", blocked, o);
                                    let swap = cmd(dest).is_some_and(|c| {
                                        matches!(c, Command::Move { dest: back, via_convoy: v, .. }
                                            if back == o.unit && !v && !via_convoy)
                                    });
                                    note("head-to-head swap of its own units", swap, o);
                                    if via_convoy {
                                        let carried = mine.iter().any(|q| {
                                            matches!(q.command, Command::Convoy { army, dest: d }
                                                if army == o.unit && d == dest)
                                        });
                                        note("via convoy with no convoy order", !carried, o);
                                    }
                                }
                                Command::Convoy { army, dest } => {
                                    let bad = !matches!(
                                        cmd(army),
                                        Some(Command::Move { dest: d, via_convoy: true, .. }) if d == dest
                                    );
                                    note("convoy for an army not convoyed there", bad, o);
                                }
                                Command::Hold => {}
                            }
                        }
                        // the library's own counter and the intent agree with the above
                        assert_eq!(contradictions(&mine), 0, "{what}: {mine:?}");
                        assert_consistent(&d, &what);
                    }
                    all.extend(d.orders);
                }
                game.process(&all).unwrap();
            }
        }
    }
    let mut total = 0;
    for ((kind, level), (seen, bad)) in &tally {
        eprintln!("{kind:40} {level:9} {bad:5} of {seen:5}");
        total += bad;
    }
    for (kind, example) in &first {
        eprintln!("first {kind}: {example}");
    }
    assert_eq!(total, 0, "self-contradicting orders");
    // the test is only worth something if the games contain the orders it checks
    for kind in [
        "support for a move not ordered",
        "support-to-hold for its own mover",
        "convoy for an army not convoyed there",
        "via convoy with no convoy order",
    ] {
        let seen: u64 = tally
            .iter()
            .filter(|((k, _), _)| *k == kind)
            .map(|(_, v)| v.0)
            .sum();
        assert!(seen >= 20, "only {seen} orders of kind: {kind}");
    }
}
