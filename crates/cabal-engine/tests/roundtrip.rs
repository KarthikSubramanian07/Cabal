//! Tier one of the replay fixtures: no data at all. Seeded random games are
//! exported, reloaded every way the engine offers, and must come back identical.

mod common;

use cabal_engine::geo::Map;
use cabal_engine::json::{SavedGame, state_from_mila, state_to_mila_with};
use cabal_engine::legal::legal_retreats;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::snapshot::Snapshot;
use cabal_engine::state::PhaseKind;
use cabal_engine::{Game, PhaseResult};
use common::{Rng, noisy_game, random_game};
use proptest::prelude::*;

const EDITIONS: [&str; 4] = ["2023", "1982", "1971", "dptg"];

fn through_json(saved: &SavedGame) -> SavedGame {
    serde_json::from_str(&serde_json::to_string(saved).unwrap()).unwrap()
}

/// Two exports must be the same file. On failure, name the first phase that
/// differs instead of printing both games.
fn assert_same_save(got: &SavedGame, want: &SavedGame, how: &str) -> Result<(), TestCaseError> {
    for (g, w) in got.phases.iter().zip(&want.phases) {
        prop_assert_eq!(&g.orders, &w.orders, "{}: orders of {}", how, w.name);
        prop_assert_eq!(&g.results, &w.results, "{}: results of {}", how, w.name);
        prop_assert_eq!(g, w, "{}: phase {}", how, w.name);
    }
    prop_assert_eq!(got.phases.len(), want.phases.len(), "{}: phase count", how);
    prop_assert!(
        got == want,
        "{}: the saves differ outside their phases",
        how
    );
    Ok(())
}

/// A ruling with adjustment orders grouped by power. A save lists orders
/// under their power, so that is the order an archived phase is read back in;
/// a live game keeps the order they arrived in. Each power's own orders keep
/// their sequence either way, which is all the adjudication depends on.
fn by_power(result: &PhaseResult) -> PhaseResult {
    let mut result = result.clone();
    if let PhaseResult::Adjustment(r) = &mut result {
        let mut pairs: Vec<_> = r.orders.iter().copied().zip(r.outcomes.drain(..)).collect();
        pairs.sort_by_key(|(o, _)| o.power);
        (r.orders, r.outcomes) = pairs.into_iter().unzip();
    }
    result
}

/// Every way of loading `saved` must reproduce `game`.
fn assert_round_trips(game: &Game) -> Result<(), TestCaseError> {
    let map = game.map();
    let saved = game.to_saved("roundtrip");
    let back = through_json(&saved);
    prop_assert_eq!(&back, &saved, "JSON round trip");

    // strict replay; the fallback rulebook must not matter, the file names its own
    let replayed = Game::from_saved(&back, Rulebook::edition_1971()).unwrap();
    prop_assert_eq!(&replayed.state, &game.state);
    prop_assert_eq!(replayed.status, game.status);
    prop_assert_eq!(replayed.rulebook, game.rulebook);
    prop_assert_eq!(&replayed.draw_members, &game.draw_members);
    prop_assert_eq!(replayed.history.len(), game.history.len());
    assert_same_save(&replayed.to_saved("roundtrip"), &saved, "replayed")?;

    let report = Game::verify_saved(&back, Rulebook::default()).unwrap();
    prop_assert!(report.is_clean(), "{:#?}", report.divergences);
    prop_assert_eq!(report.phases, game.history.len());

    // trusted restore: nothing adjudicated, same game
    let resumed = Game::resume(&back, Rulebook::edition_1971()).unwrap();
    prop_assert_eq!(&resumed.state, &game.state);
    prop_assert_eq!(resumed.status, game.status);
    prop_assert!(resumed.history.is_empty());
    prop_assert_eq!(resumed.phase_count(), game.phase_count());
    assert_same_save(&resumed.to_saved("roundtrip"), &saved, "resumed")?;

    // a past ruling reads the same from the archive as it did live
    for i in 0..game.phase_count() {
        let live = game.record_at(i).unwrap();
        let archived = resumed.record_at(i).unwrap();
        prop_assert_eq!(
            by_power(&archived.result),
            by_power(&live.result),
            "ruling of phase {}",
            i
        );
    }

    // snapshot, alone and with the save as history
    let snapshot: Snapshot =
        serde_json::from_str(&serde_json::to_string(&game.snapshot()).unwrap()).unwrap();
    let alone = Game::from_snapshot(&snapshot, None).unwrap();
    prop_assert_eq!(&alone.state, &game.state);
    prop_assert_eq!(alone.status, game.status);
    let restored = Game::from_snapshot(&snapshot, Some(&back)).unwrap();
    prop_assert_eq!(&restored.state, &game.state);
    assert_same_save(&restored.to_saved("roundtrip"), &saved, "from snapshot")?;

    // every recorded state is lossless on its own, and a retreat state that
    // lost Cabal's extras still offers exactly the recorded retreats
    for (i, record) in game.history.iter().enumerate() {
        let mila = state_to_mila_with(map, &record.state, game.rulebook);
        prop_assert_eq!(&state_from_mila(map, &mila).unwrap(), &record.state);
        if record.state.phase.kind != PhaseKind::Retreat {
            continue;
        }
        let mut stripped = mila.clone();
        stripped.cabal = None;
        let approx = state_from_mila(map, &stripped).unwrap();
        for p in map.power_ids() {
            prop_assert_eq!(
                legal_retreats(map, &approx, p),
                legal_retreats(map, &record.state, p),
                "retreats of {} in {}",
                map.power(p).name,
                record.state.phase
            );
        }
        // a save that begins in this retreat phase replays to the same end
        let truncated = SavedGame {
            phases: saved.phases[i..].to_vec(),
            ..saved.clone()
        };
        let tail = Game::from_saved(&truncated, Rulebook::default()).unwrap();
        prop_assert_eq!(&tail.state, &game.state);
        let report = Game::verify_saved(&truncated, Rulebook::default()).unwrap();
        prop_assert!(report.is_clean(), "{:#?}", report.divergences);
    }

    // resuming mid-game and playing on gives the same record as never stopping
    if game.history.len() >= 2 && !game.is_finished() {
        let mut live = game.clone();
        let mut resumed = resumed;
        for seed in 0..3 {
            if live.is_finished() {
                break;
            }
            let orders = common::random_orders(&live, &mut Rng::new(seed));
            live.process(&orders).unwrap();
            resumed.process(&orders).unwrap();
        }
        prop_assert_eq!(&resumed.state, &live.state);
        assert_same_save(
            &resumed.to_saved("roundtrip"),
            &live.to_saved("roundtrip"),
            "resumed and played on",
        )?;
    }
    Ok(())
}

/// Each case plays and reloads a whole game, so it costs about twenty times a
/// single-phase property; the nightly budget in `PROPTEST_CASES` is scaled to match.
fn cases() -> u32 {
    std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .map_or(48, |n| (n / 20).max(48))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(cases()))]

    #[test]
    fn prop_saved_games_round_trip(seed in any::<u64>(), edition in 0..4usize, phases in 1..40usize, draw in any::<bool>()) {
        let game = random_game(Map::standard(), EDITIONS[edition], seed, phases, draw);
        assert_round_trips(&game)?;
    }

    /// Illegal, duplicate and foreign orders, and orders for nothing at all:
    /// the record must say what was submitted and replay to the same rulings.
    #[test]
    fn prop_games_with_illegal_orders_round_trip(seed in any::<u64>(), edition in 0..4usize, phases in 1..30usize) {
        let game = noisy_game(Map::standard(), EDITIONS[edition], seed, phases);
        assert_round_trips(&game)?;
    }

    #[test]
    fn prop_duel_games_round_trip(seed in any::<u64>(), phases in 1..12usize) {
        let game = random_game(Map::by_name("duel").unwrap(), "2023", seed, phases, false);
        assert_round_trips(&game)?;
    }
}

/// The property above on a fixed, longer set of seeds, so plain `cargo test`
/// always covers retreats, eliminations and civil disorder.
#[test]
fn long_seeded_games_round_trip() {
    let mut retreats = 0;
    for seed in 0..12u64 {
        let edition = EDITIONS[seed as usize % 4];
        let game = random_game(Map::standard(), edition, seed, 80, seed % 5 == 0);
        retreats += game
            .history
            .iter()
            .filter(|r| r.state.phase.kind == PhaseKind::Retreat)
            .count();
        assert_round_trips(&game).unwrap();
    }
    assert!(retreats > 5, "the seeds no longer reach retreat phases");
}

/// The noisy property on fixed seeds, checking that the noise really produces
/// every kind of order the record has to carry.
#[test]
fn seeded_games_with_illegal_orders_round_trip() {
    use cabal_engine::outcome::{AdjustOutcome, Illegal, OrderOutcome, RetreatOutcome};

    let (mut foreign, mut duplicate, mut other, mut retreat, mut adjust) = (0, 0, 0, 0, 0);
    for seed in 0..16u64 {
        let game = noisy_game(Map::standard(), EDITIONS[seed as usize % 4], seed, 60);
        for record in &game.history {
            match &record.result {
                PhaseResult::Movement(r) => {
                    for out in &r.outcomes {
                        match out {
                            OrderOutcome::Illegal {
                                reason: Illegal::ForeignUnit,
                                ..
                            } => foreign += 1,
                            OrderOutcome::Illegal {
                                reason: Illegal::DuplicateOrder,
                                ..
                            } => duplicate += 1,
                            OrderOutcome::Illegal { .. } => other += 1,
                            _ => {}
                        }
                    }
                }
                PhaseResult::Retreat(r) => {
                    retreat += r
                        .outcomes
                        .iter()
                        .filter(|o| matches!(o, RetreatOutcome::Illegal { .. }))
                        .count();
                }
                PhaseResult::Adjustment(r) => {
                    adjust += r
                        .outcomes
                        .iter()
                        .filter(|o| matches!(o, AdjustOutcome::Illegal { .. }))
                        .count();
                }
            }
        }
        assert_round_trips(&game).unwrap();
    }
    assert!(
        foreign > 5 && duplicate > 5 && other > 5 && retreat > 2 && adjust > 5,
        "the noise no longer covers every kind: {foreign} foreign, {duplicate} duplicate, \
         {other} otherwise illegal, {retreat} illegal retreats, {adjust} illegal adjustments"
    );
}
