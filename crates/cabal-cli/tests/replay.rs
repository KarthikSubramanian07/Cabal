//! `cabal replay`: files and directories, a divergence count, and exit codes.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn games() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../cabal-engine/tests/data/games")
}

fn replay(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cabal"))
        .arg("replay")
        .args(args)
        .output()
        .unwrap()
}

/// A scratch directory unique to one test, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("cabal-replay-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn a_clean_fixture_reports_zero_divergences() {
    let file = games().join("generated/convoy_and_coasts.json");
    let output = replay(&[file.to_str().unwrap()]);
    let text = stdout(&output);
    assert!(output.status.success(), "{text}");
    assert!(
        text.contains("convoy_and_coasts.json: 4 phases, 0 divergences"),
        "{text}"
    );
    assert!(
        text.contains("1 games, 4 phases, 0 diverged, 0 unreadable"),
        "{text}"
    );
}

#[test]
fn a_directory_is_walked_recursively_and_the_manifest_is_skipped() {
    let output = replay(&[games().to_str().unwrap()]);
    let text = stdout(&output);
    assert!(output.status.success(), "{text}");
    for name in [
        "generated/opening_1901.json",
        "generated/retreat_start.json",
        "external/cicero_433761.json: 35 phases, 0 divergences",
    ] {
        assert!(text.contains(name), "{name} missing from:\n{text}");
    }
    assert!(!text.contains("manifest.json"), "{text}");
    assert!(text.contains("0 diverged, 0 unreadable"), "{text}");
    let games_line = text.lines().last().unwrap();
    let count: usize = games_line.split(' ').next().unwrap().parse().unwrap();
    assert!(count >= 11, "{games_line}");
}

#[test]
fn a_tampered_copy_fails_and_names_the_phase() {
    let scratch = Scratch::new("tampered");
    let text = fs::read_to_string(games().join("generated/convoy_and_coasts.json")).unwrap();
    // England's army never reached Norway in this version of events
    let needle = "\"F NTH\",\"F NWG\",\"A NWY\"";
    assert!(text.contains(needle), "fixture changed; update the needle");
    let tampered = scratch.0.join("tampered.json");
    fs::write(
        &tampered,
        text.replacen(needle, "\"F NTH\",\"F NWG\",\"A YOR\"", 1),
    )
    .unwrap();

    let output = replay(&[tampered.to_str().unwrap()]);
    let text = stdout(&output);
    assert_eq!(output.status.code(), Some(1), "{text}");
    assert!(text.contains("F1901M units ENGLAND"), "{text}");
    assert!(text.contains("1 diverged"), "{text}");

    // --json carries the same report for tools
    let output = replay(&["--json", tampered.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1));
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["games"], 1);
    assert_eq!(json["diverged"], 1);
    let divergences = json["reports"][0]["report"]["divergences"]
        .as_array()
        .unwrap();
    assert!(
        divergences
            .iter()
            .any(|d| d["phase"] == "F1901M" && d["field"] == "units" && d["subject"] == "ENGLAND"),
        "{divergences:#?}"
    );
}

#[test]
fn a_clean_and_a_tampered_game_together_still_fail() {
    let scratch = Scratch::new("mixed");
    let source = games().join("generated/opening_1901.json");
    fs::copy(&source, scratch.0.join("good.json")).unwrap();
    let text = fs::read_to_string(&source).unwrap();
    fs::write(
        scratch.0.join("bad.json"),
        text.replacen("\"bounce\"", "\"cut\"", 1),
    )
    .unwrap();
    let output = replay(&[scratch.0.to_str().unwrap()]);
    let text = stdout(&output);
    assert_eq!(output.status.code(), Some(1), "{text}");
    assert!(
        text.contains("good.json: 2 phases, 0 divergences"),
        "{text}"
    );
    assert!(text.contains("bad.json: 2 phases, 1 divergences"), "{text}");
    assert!(text.contains("S1901M results"), "{text}");
    assert!(
        text.contains("2 games, 4 phases, 1 diverged, 0 unreadable"),
        "{text}"
    );
}

#[test]
fn unreadable_input_exits_with_two() {
    let scratch = Scratch::new("unreadable");
    assert_eq!(replay(&[]).status.code(), Some(2));
    assert_eq!(replay(&["/no/such/file.json"]).status.code(), Some(2));
    assert_eq!(
        replay(&[scratch.0.to_str().unwrap()]).status.code(),
        Some(2),
        "empty directory"
    );
    let junk = scratch.0.join("junk.json");
    fs::write(&junk, "{\"not\": \"a game\"}").unwrap();
    let output = replay(&[junk.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(2));
    assert!(stdout(&output).contains("not a saved game"));
    assert_eq!(replay(&["--rulebook", "1492", "x"]).status.code(), Some(2));
}

#[test]
fn the_fallback_rulebook_applies_to_files_that_name_none() {
    let scratch = Scratch::new("rulebook");
    let text = fs::read_to_string(games().join("external/cicero_433761.json")).unwrap();
    let unnamed = scratch.0.join("unnamed.json");
    fs::write(
        &unnamed,
        text.replacen("\"rules\": [\"1982\"]", "\"rules\": []", 1),
    )
    .unwrap();
    let path = unnamed.to_str().unwrap();
    let output = replay(&[path]);
    assert_eq!(output.status.code(), Some(1), "2023 civil disorder differs");
    assert!(stdout(&output).contains("W1908A units FRANCE"));
    assert!(replay(&["--rulebook", "1982", path]).status.success());
}
