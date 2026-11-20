//! Saved games arrive from outside: the sandbox imports files a player picked,
//! and `cabal replay` reads whatever it is pointed at. Loading one must return
//! a value or an error, never panic. This mutates the committed fixtures several
//! hundred ways; `fuzz/fuzz_targets/saved.rs` does the same with a real fuzzer.

mod common;

use std::fs;
use std::path::Path;

use cabal_engine::Game;
use cabal_engine::json::SavedGame;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::snapshot::Snapshot;
use common::Rng;
use serde_json::Value;

const JUNK: [&str; 14] = [
    "",
    "A PAR",
    "*A PAR",
    "F STP/SC",
    "A SWI",
    "F MUN",
    "PAR",
    "A PAR - MOS",
    "A PAR R PAR",
    "F NTH C A LON - NWY",
    "W1901A",
    "S1901R",
    "COMPLETED",
    "FRANCE",
];

/// Paths to every node of a JSON document.
fn paths(value: &Value, here: &mut Vec<String>, out: &mut Vec<Vec<String>>) {
    out.push(here.clone());
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                here.push(k.clone());
                paths(v, here, out);
                here.pop();
            }
        }
        Value::Array(list) => {
            for (i, v) in list.iter().enumerate() {
                here.push(i.to_string());
                paths(v, here, out);
                here.pop();
            }
        }
        _ => {}
    }
}

fn node<'a>(value: &'a mut Value, path: &[String]) -> Option<&'a mut Value> {
    let mut at = value;
    for step in path {
        at = match at {
            Value::Object(map) => map.get_mut(step)?,
            Value::Array(list) => list.get_mut(step.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(at)
}

/// Change one thing somewhere in the document.
fn mutate(doc: &mut Value, rng: &mut Rng) {
    let mut all = Vec::new();
    paths(doc, &mut Vec::new(), &mut all);
    let path = all[rng.below(all.len())].clone();
    let Some(target) = node(doc, &path) else {
        return;
    };
    match target {
        Value::String(s) => *s = JUNK[rng.below(JUNK.len())].to_string(),
        Value::Array(list) => match rng.below(4) {
            0 => list.clear(),
            1 if !list.is_empty() => {
                let copy = list[rng.below(list.len())].clone();
                list.push(copy);
            }
            2 if !list.is_empty() => {
                list.remove(rng.below(list.len()));
            }
            _ => list.push(Value::String(JUNK[rng.below(JUNK.len())].to_string())),
        },
        Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            if keys.is_empty() {
                return;
            }
            let key = keys[rng.below(keys.len())].clone();
            if rng.chance(50) {
                map.remove(&key);
            } else {
                let value = map[&key].clone();
                map.insert(JUNK[rng.below(JUNK.len())].to_string(), value);
            }
        }
        Value::Number(n) => *n = serde_json::Number::from(rng.below(40) as u64),
        Value::Bool(b) => *b = !*b,
        Value::Null => {}
    }
}

/// Every loader, on whatever the document now says.
fn load_every_way(doc: &Value) {
    let Ok(saved) = serde_json::from_value::<SavedGame>(doc.clone()) else {
        return;
    };
    let rulebook = Rulebook::default();
    let _ = Game::verify_saved(&saved, rulebook);
    if let Ok(game) = Game::from_saved(&saved, rulebook) {
        // what the engine wrote, it must be able to read back (the fuzzer holds the same line)
        let exported = game.to_saved(&saved.id);
        let again = Game::from_saved(&exported, rulebook).expect("own export replays");
        assert_eq!(again.state, game.state);
    }
    if let Ok(mut game) = Game::resume(&saved, rulebook) {
        let exported = game.to_saved(&saved.id);
        for i in 0..game.phase_count() {
            let _ = game.record_at(i);
            let _ = game.state_after(i);
        }
        let snapshot: Snapshot =
            serde_json::from_str(&serde_json::to_string(&game.snapshot()).unwrap()).unwrap();
        let _ = Game::from_snapshot(&snapshot, Some(&exported));
        // and the game must still be playable
        let orders = common::random_orders(&game, &mut Rng::new(1));
        let _ = game.process(&orders);
    }
}

#[test]
fn mutated_saved_games_never_panic() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/games");
    let fixtures = [
        "generated/standoff_retreats.json",
        "generated/retreat_start.json",
        "generated/convoy_and_coasts.json",
        "generated/pledges_and_draw.json",
        "generated/duel_build_anywhere.json",
    ];
    // enough to reach every loader's error paths in a debug build; the nightly
    // fuzz target goes deeper
    let cases: usize = std::env::var("UNTRUSTED_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120);
    let mut rng = Rng::new(0xCABA1);
    for name in fixtures {
        let text = fs::read_to_string(dir.join(name)).unwrap();
        let original: Value = serde_json::from_str(&text).unwrap();
        for _ in 0..cases {
            let mut doc = original.clone();
            for _ in 0..=rng.below(3) {
                mutate(&mut doc, &mut rng);
            }
            load_every_way(&doc);
        }
    }
}

/// Found by `fuzz/fuzz_targets/saved.rs`: a state named `S0950M` loaded as the year 950, the
/// export wrote it back as `S950M`, and that did not parse. Every phase name the engine writes
/// must read back as the same phase.
#[test]
fn an_export_from_an_early_year_reads_back() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/untrusted/year_0950.json");
    let saved: SavedGame = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let rulebook = Rulebook::default();
    let game = Game::from_saved(&saved, rulebook).expect("the document loads");
    let exported = game.to_saved(&saved.id);
    assert!(
        exported.phases.iter().all(|p| p.state.name.len() == 6),
        "{:?}",
        exported
            .phases
            .iter()
            .map(|p| &p.state.name)
            .collect::<Vec<_>>()
    );
    let again = Game::from_saved(&exported, rulebook).expect("own export replays");
    assert_eq!(again.state, game.state);
    load_every_way(&serde_json::to_value(&saved).unwrap());
}

/// Found by the fuzzer, from the seed above: a movement-phase state listing a dislodged unit
/// (`*A MUN`). It loaded with that unit dislodged, the export (which only lists dislodged units
/// in retreat phases) dropped it, and the read-back differed. A dislodged unit outside a retreat
/// phase is now refused.
#[test]
fn a_dislodged_unit_outside_a_retreat_phase_is_refused() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data/untrusted/dislodged_in_movement.json");
    let saved: SavedGame = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    assert!(Game::from_saved(&saved, Rulebook::default()).is_err());
    load_every_way(&serde_json::to_value(&saved).unwrap());
}

/// Raised in review: the year used to saturate at `u16::MAX`, so a game imported near it would
/// play `S65535M`, `F65535M` and `W65535A` again every "year", while hosts key orders by phase
/// name. The calendar now ends at `Phase::LAST_YEAR`: its fall ends the game in a draw, and a
/// state left at its last adjustment cannot be played on.
#[test]
fn the_calendar_ends_in_a_draw_instead_of_repeating_its_last_year() {
    use cabal_engine::game::{GameError, Status};
    use cabal_engine::geo::Map;
    use cabal_engine::state::{GameState, Phase, PhaseKind, Season};
    let map = Map::standard();
    let rulebook = Rulebook::default();
    let mut last_fall = GameState::initial(map);
    last_fall.phase = Phase::new(Phase::LAST_YEAR, Season::Fall, PhaseKind::Movement);
    let mut game = Game::from_state(map, rulebook, last_fall);
    game.process(&[]).expect("the last fall is played");
    assert_eq!(game.status, Status::Draw);
    assert_eq!(game.draw_members.len(), 7);
    assert_eq!(game.phase().to_string(), "W9999A");
    assert_eq!(game.process(&[]).err(), Some(GameError::Finished));
    // What it writes, it reads back, with every phase named once.
    let exported = game.to_saved("CAL");
    let names: Vec<_> = exported.phases.iter().map(|p| p.name.clone()).collect();
    let unique: std::collections::BTreeSet<_> = names.iter().collect();
    assert_eq!(unique.len(), names.len(), "{names:?}");
    let again = Game::from_saved(&exported, rulebook).expect("own export replays");
    assert_eq!(
        (again.state, again.status),
        (game.state.clone(), Status::Draw)
    );
    // A state made by hand at the last adjustment has no spring to go to.
    let mut last_winter = GameState::initial(map);
    last_winter.phase = Phase::new(Phase::LAST_YEAR, Season::Winter, PhaseKind::Adjustment);
    let mut stuck = Game::from_state(map, rulebook, last_winter);
    assert_eq!(stuck.process(&[]).err(), Some(GameError::Finished));
    assert_eq!(stuck.status, Status::Draw);
    assert_eq!(Phase::parse("S10000M"), None);
}
