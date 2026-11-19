//! Tiers two and three of the replay fixtures: every game under
//! `tests/data/games/` must replay with zero divergences, be listed in the
//! provenance manifest, and cover what the manifest says it covers.
//!
//! Generated games are also compared byte for byte with what the generator in
//! `tests/common/golden.rs` writes today. Regenerate after an intended change:
//!
//! ```text
//! UPDATE_FIXTURES=1 cargo test -p cabal-engine --test replay
//! ```

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use cabal_engine::Game;
use cabal_engine::json::SavedGame;
use cabal_engine::rulebook::Rulebook;
use common::golden::{covers, golden_games, to_file_text};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Entry {
    /// Path relative to `tests/data/games/`.
    file: String,
    /// `generated`, `recorded` or `external`.
    tier: String,
    /// Where the game came from: a script, a seed, or a URL.
    source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    licence: Option<String>,
    /// Engine version that wrote the file, when Cabal wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine: Option<String>,
    /// Adjudicated phases.
    phases: usize,
    /// What the game exercises, recomputed and checked by this test.
    covers: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Manifest {
    about: String,
    games: Vec<Entry>,
}

fn games_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/games")
}

fn read_manifest() -> Manifest {
    let path = games_dir().join("manifest.json");
    let text = fs::read_to_string(&path).expect("tests/data/games/manifest.json exists");
    serde_json::from_str(&text).expect("manifest parses")
}

fn game_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            game_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "json")
            && path.file_name().is_some_and(|n| n != "manifest.json")
        {
            out.push(path);
        }
    }
}

fn relative(path: &Path) -> String {
    path.strip_prefix(games_dir())
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/")
}

fn entry_for(file: String, tier: &str, source: String, saved: &SavedGame) -> Entry {
    Entry {
        file,
        tier: tier.to_string(),
        source,
        licence: None,
        engine: saved.cabal.as_ref().map(|m| m.engine.clone()),
        phases: saved.phases.len() - 1,
        covers: covers(saved).into_iter().collect(),
    }
}

/// Both tests may run in parallel; the fixtures are rewritten at most once.
fn maybe_update_fixtures() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        ONCE.call_once(update_fixtures);
    }
}

/// With `UPDATE_FIXTURES=1`: rewrite the generated games and their manifest
/// entries, and refresh the computed fields of every other entry.
fn update_fixtures() {
    let dir = games_dir();
    let mut manifest = read_manifest();
    let generated = golden_games();
    let wanted: BTreeSet<String> = generated
        .iter()
        .map(|g| format!("generated/{}.json", g.name))
        .collect();
    for old in fs::read_dir(dir.join("generated")).unwrap() {
        let path = old.unwrap().path();
        if !wanted.contains(&relative(&path)) {
            fs::remove_file(path).unwrap();
        }
    }
    let mut games: Vec<Entry> = Vec::new();
    for g in &generated {
        let file = format!("generated/{}.json", g.name);
        fs::write(dir.join(&file), to_file_text(&g.saved)).unwrap();
        games.push(entry_for(file, "generated", g.source.clone(), &g.saved));
    }
    for mut entry in manifest.games.into_iter().filter(|e| e.tier != "generated") {
        let text = fs::read_to_string(dir.join(&entry.file)).unwrap();
        let saved: SavedGame = serde_json::from_str(&text).unwrap();
        let fresh = entry_for(
            entry.file.clone(),
            &entry.tier,
            entry.source.clone(),
            &saved,
        );
        entry.phases = fresh.phases;
        entry.covers = fresh.covers;
        entry.engine = fresh.engine;
        games.push(entry);
    }
    manifest.games = games;
    let mut text = serde_json::to_string_pretty(&manifest).unwrap();
    text.push('\n');
    fs::write(dir.join("manifest.json"), text).unwrap();
}

#[test]
fn every_saved_game_replays_without_divergence() {
    maybe_update_fixtures();
    let manifest = read_manifest();
    let listed: BTreeMap<&str, &Entry> = manifest
        .games
        .iter()
        .map(|e| (e.file.as_str(), e))
        .collect();
    let mut files = Vec::new();
    game_files(&games_dir(), &mut files);
    assert!(files.len() >= 10, "only {} fixtures found", files.len());
    assert_eq!(
        files.iter().map(|f| relative(f)).collect::<BTreeSet<_>>(),
        listed
            .keys()
            .map(|k| k.to_string())
            .collect::<BTreeSet<_>>(),
        "manifest.json must list exactly the games on disk"
    );

    let mut all_covered = BTreeSet::new();
    for path in &files {
        let name = relative(path);
        let entry = listed[name.as_str()];
        let text = fs::read_to_string(path).unwrap();
        let saved: SavedGame =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name} does not parse: {e}"));

        let report = Game::verify_saved(&saved, Rulebook::default())
            .unwrap_or_else(|e| panic!("{name} cannot be replayed: {e}"));
        assert!(
            report.is_clean(),
            "{name} diverges:\n{}",
            report
                .divergences
                .iter()
                .map(|d| format!("  {d}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        assert_eq!(
            report.phases, entry.phases,
            "{name}: phases in the manifest"
        );
        assert_eq!(
            report.strict,
            entry.tier != "external",
            "{name}: Cabal-written files carry the cabal block, external ones do not"
        );

        let game = Game::from_saved(&saved, Rulebook::default())
            .unwrap_or_else(|e| panic!("{name} failed to replay: {e}"));
        let resumed = Game::resume(&saved, Rulebook::default()).unwrap();
        assert_eq!(resumed.state, game.state, "{name}: trusted restore");
        assert_eq!(resumed.status, game.status, "{name}: trusted restore");
        if saved.cabal.is_some() {
            // Bit for bit: exporting the replayed game gives back the recorded file.
            assert_eq!(game.to_saved(&saved.id), saved, "{name} did not round-trip");
            assert_eq!(resumed.to_saved(&saved.id), saved, "{name}: resumed export");
            assert_eq!(entry.engine, saved.cabal.as_ref().map(|m| m.engine.clone()));
        }

        let tags: Vec<String> = covers(&saved).into_iter().collect();
        assert_eq!(tags, entry.covers, "{name}: coverage in the manifest");
        all_covered.extend(tags);
        if entry.tier != "generated" {
            assert!(
                entry.licence.is_some(),
                "{name}: a licence must be recorded"
            );
        }
    }

    // games played on Cabal itself, from both places people and bots play
    let recorded: Vec<&str> = manifest
        .games
        .iter()
        .filter(|e| e.tier == "recorded")
        .map(|e| e.file.as_str())
        .collect();
    assert!(
        recorded.len() >= 10,
        "only {} recorded games",
        recorded.len()
    );
    for from in ["recorded/sandbox_", "recorded/arena_"] {
        assert!(
            recorded.iter().any(|f| f.starts_with(from)),
            "no recorded game under {from}*"
        );
    }

    // the mechanics the fixture set exists to cover
    for needed in [
        "bounce",
        "build",
        "build_anywhere",
        "civil_disorder",
        "convoy",
        "disband",
        "dislodgement",
        "draw",
        "elimination",
        "map:duel",
        "pledges",
        "press",
        "retreat",
        "retreat_bounce",
        "retreat_disband",
        "rulebook:1971",
        "rulebook:1982",
        "rulebook:dptg",
        "short_victory",
        "solo",
        "split_coast",
        "standoff",
        "starts_in_retreat",
        "support",
        "waive",
    ] {
        assert!(all_covered.contains(needed), "no fixture covers {needed}");
    }
}

/// The committed golden games are exactly what the generator writes today, so
/// a change in any recorded ruling fails here with the file named.
#[test]
fn generated_games_match_the_generator() {
    maybe_update_fixtures();
    let dir = games_dir().join("generated");
    let manifest = read_manifest();
    let generated = golden_games();
    assert!(generated.len() >= 10);
    for g in &generated {
        let file = format!("generated/{}.json", g.name);
        let on_disk = fs::read_to_string(dir.join(format!("{}.json", g.name)))
            .unwrap_or_else(|e| panic!("{file} is missing ({e}); run with UPDATE_FIXTURES=1"));
        assert!(
            on_disk == to_file_text(&g.saved),
            "{file} no longer matches the generator. If a rules change is intended, \
             regenerate with UPDATE_FIXTURES=1 and review the diff."
        );
        let entry = manifest
            .games
            .iter()
            .find(|e| e.file == file)
            .unwrap_or_else(|| panic!("{file} is not in the manifest"));
        assert_eq!(entry.source, g.source);
    }
}
