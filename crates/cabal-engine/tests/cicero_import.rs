use std::fs;
use std::path::Path;

use cabal_engine::Rulebook;
use cabal_engine::game::Game;
use cabal_engine::json::SavedGame;

fn fixture() -> SavedGame {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/cicero/game.json");
    let raw = fs::read_to_string(&path).unwrap();
    serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("{} did not deserialize as SavedGame: {e}", path.display()))
}

#[test]
fn imports_a_real_cicero_game_json() {
    let saved = fixture();
    assert_eq!(saved.id, "zHJfwg72CWXs");
    assert_eq!(saved.map, "standard");
    assert_eq!(saved.phases.len(), 2);
}

#[test]
fn replays_the_cicero_opening_to_the_recorded_fall_position() {
    // from_saved re-adjudicates Spring 1901 and fails unless the engine
    // reproduces Cicero's recorded Fall 1901 units and centres exactly.
    let game = Game::from_saved(&fixture(), Rulebook::default()).unwrap();
    assert_eq!(game.phase().to_string(), "F1901M");
}
