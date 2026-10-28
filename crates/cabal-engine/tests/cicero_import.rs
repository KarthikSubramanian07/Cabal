use std::fs;
use std::path::Path;

use cabal_engine::json::SavedGame;

#[test]
fn imports_a_real_cicero_game_json() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/cicero/game.json");
    let raw = fs::read_to_string(&path).unwrap();
    let saved: SavedGame = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("{} did not deserialize as SavedGame: {e}", path.display()));
    assert_eq!(saved.id, "zHJfwg72CWXs");
    assert_eq!(saved.map, "standard");
    assert_eq!(saved.phases.len(), 2);
}
