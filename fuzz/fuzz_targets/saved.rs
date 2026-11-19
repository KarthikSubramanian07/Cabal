#![no_main]
//! Saved games come from outside (the sandbox imports files a player picked,
//! `cabal replay` reads whatever it is given). Every loader must return a value
//! or an error on arbitrary input, and a game that loads must stay playable.
use cabal_engine::{Game, json::SavedGame, rulebook::Rulebook, snapshot::Snapshot};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(saved) = serde_json::from_slice::<SavedGame>(data) else {
        return;
    };
    if saved.phases.len() > 24 {
        return; // keep single executions fast; depth is not what this target is for
    }
    let rulebook = Rulebook::default();
    let _ = Game::verify_saved(&saved, rulebook);
    if let Ok(game) = Game::from_saved(&saved, rulebook) {
        // what the engine wrote, it must be able to read back and reproduce
        let exported = game.to_saved(&saved.id);
        let again = Game::from_saved(&exported, rulebook).expect("own export replays");
        assert_eq!(again.state, game.state);
        let report = Game::verify_saved(&exported, rulebook).expect("own export verifies");
        assert!(report.is_clean(), "{:?}", report.divergences);
    }
    if let Ok(mut game) = Game::resume(&saved, rulebook) {
        let exported = game.to_saved(&saved.id);
        for i in 0..game.phase_count() {
            let _ = game.record_at(i);
            let _ = game.state_after(i);
        }
        let text = serde_json::to_string(&game.snapshot()).unwrap();
        let snapshot: Snapshot = serde_json::from_str(&text).unwrap();
        let _ = Game::from_snapshot(&snapshot, Some(&exported));
        let _ = game.process(&[]);
    }
});
