//! A complete game adjudicated by someone else: the published Cicero game
//! `game_433761_ENGLAND_AG` (see `tests/data/games/README.md`).

use std::fs;
use std::path::Path;

use cabal_engine::Rulebook;
use cabal_engine::game::Game;
use cabal_engine::json::{ReplayError, SavedGame};
use cabal_engine::verify::DivergenceField;

fn fixture() -> SavedGame {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/games/external/cicero_433761.json");
    let raw = fs::read_to_string(&path).unwrap();
    serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("{} did not deserialize as SavedGame: {e}", path.display()))
}

#[test]
fn imports_a_real_cicero_game_json() {
    let saved = fixture();
    assert_eq!(saved.id, "zHJfwg72CWXs");
    assert_eq!(saved.map, "standard");
    assert_eq!(saved.phases.len(), 36);
    assert!(saved.cabal.is_none(), "not written by Cabal");
}

#[test]
fn replays_the_whole_cicero_game_to_the_recorded_position() {
    // from_saved re-adjudicates all 35 phases (11 of them retreats) and fails
    // unless the engine reproduces every recorded set of units and centres.
    let saved = fixture();
    let game = Game::from_saved(&saved, Rulebook::default()).unwrap();
    assert_eq!(game.phase().to_string(), "S1909M");
    assert_eq!(game.history.len(), 35);
    assert_eq!(game.rulebook, Rulebook::edition_1982(), "named by the file");

    let report = Game::verify_saved(&saved, Rulebook::default()).unwrap();
    assert!(report.is_clean(), "{:#?}", report.divergences);
    assert!(!report.strict);
}

#[test]
fn the_rulebook_decides_the_winter_1908_civil_disorder() {
    // France must remove two of three units and gives no orders. The record
    // keeps the army nearest a French home centre (the pre-2023 rule); the
    // 2023 rule keeps the one standing on France's last centre instead.
    let mut saved = fixture();
    saved.rules.clear();
    assert_eq!(
        Game::from_saved(&saved, Rulebook::edition_2023()).unwrap_err(),
        ReplayError::Diverged {
            phase: "W1908A".into()
        }
    );
    let report = Game::verify_saved(&saved, Rulebook::edition_2023()).unwrap();
    assert_eq!(report.divergences.len(), 1, "{:#?}", report.divergences);
    let d = &report.divergences[0];
    assert_eq!(
        (d.phase.as_str(), d.field),
        ("W1908A", DivergenceField::Units)
    );
    assert_eq!(d.subject, "FRANCE");
    assert_eq!((d.expected.as_str(), d.got.as_str()), ("A RUH", "A WAR"));
    assert!(
        Game::verify_saved(&saved, Rulebook::edition_1982())
            .unwrap()
            .is_clean()
    );
}
