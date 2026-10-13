use std::fs;
use std::path::Path;

use cabal_engine::Game;
use cabal_engine::json::SavedGame;
use cabal_engine::rulebook::Rulebook;

#[test]
fn every_saved_game_replays_without_divergence() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/games");
    let mut count = 0;
    for entry in fs::read_dir(&dir).expect("tests/data/games exists") {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        let saved: SavedGame = serde_json::from_str(&text).unwrap();
        if let Err(e) = Game::from_saved(&saved, Rulebook::default()) {
            panic!("{} failed to replay: {e}", path.display());
        }
        count += 1;
    }
    assert!(count > 0, "no fixtures found in {}", dir.display());
}
