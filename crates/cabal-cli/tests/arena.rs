//! End to end: `cabal arena` plays, writes its summary and fixtures, and every
//! fixture is accepted by `cabal replay`.

use std::path::{Path, PathBuf};
use std::process::Command;

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn arena(out: &Path, extra: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_cabal"))
        .args(["arena", "--games", "6", "--seed", "3", "--max-year", "1903"])
        .args(["--levels", "standard,easy", "--out"])
        .arg(out)
        .args(extra)
        .output()
        .unwrap()
}

/// The summary without the fields that measure the machine rather than the play.
fn stable(path: &Path) -> serde_json::Value {
    let mut v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for key in ["seconds", "games_per_second", "jobs"] {
        v.as_object_mut().unwrap().remove(key);
    }
    for row in v["by_level"].as_array_mut().unwrap() {
        row.as_object_mut().unwrap().remove("mean_decision_us");
        row.as_object_mut().unwrap().remove("max_decision_us");
    }
    v
}

#[test]
fn arena_writes_a_summary_and_fixtures_that_replay() {
    let out = scratch("arena-a");
    let run = arena(&out, &[]);
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let text = String::from_utf8(run.stdout).unwrap();
    assert!(text.starts_with("# Cabal arena"));
    assert!(text.contains("| Illegal orders | 0 |"));
    assert!(text.contains("| Orders refused by the validator | 0 |"));
    assert!(text.contains("| Self-contradicting orders | 0 |"));
    assert!(text.contains("| Void supports | 0 of "));
    assert!(text.contains("| Void convoys | 0 of "));
    assert!(text.contains("| Replay divergences | 0 |"));
    assert!(text.trim_end().ends_with("PASS"));
    assert_eq!(
        std::fs::read_to_string(out.join("summary.md")).unwrap(),
        text
    );

    let summary = stable(&out.join("summary.json"));
    assert_eq!(summary["games"], 6);
    assert_eq!(summary["illegal_orders"], 0);
    assert_eq!(summary["incomplete_decisions"], 0);
    assert_eq!(summary["rejected_orders"], 0);
    assert_eq!(summary["contradictions"], 0);
    assert_eq!(summary["void_supports"], 0);
    assert!(summary["supports"].as_u64().unwrap() > 50);
    assert_eq!(summary["game_reports"].as_array().unwrap().len(), 6);
    assert!(summary["orders"].as_u64().unwrap() > 500);
    let centres: u64 = summary["game_reports"][0]["centres"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_u64().unwrap())
        .sum();
    assert!((22..=34).contains(&centres));

    let mut fixtures = 0;
    for entry in std::fs::read_dir(out.join("games")).unwrap() {
        let path = entry.unwrap().path();
        let replay = Command::new(env!("CARGO_BIN_EXE_cabal"))
            .arg("replay")
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            replay.status.success(),
            "{}: {}",
            path.display(),
            String::from_utf8_lossy(&replay.stderr)
        );
        fixtures += 1;
    }
    assert_eq!(fixtures, 6);

    // same arguments, different thread count: the same games, move for move
    let again = scratch("arena-b");
    assert!(arena(&again, &["--jobs", "1"]).status.success());
    assert_eq!(stable(&again.join("summary.json")), summary);
    for entry in std::fs::read_dir(out.join("games")).unwrap() {
        let path = entry.unwrap().path();
        let twin = again.join("games").join(path.file_name().unwrap());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            std::fs::read(&twin).unwrap(),
            "{} differs between runs",
            path.display()
        );
    }
}

#[test]
fn arena_rejects_bad_arguments() {
    let run = Command::new(env!("CARGO_BIN_EXE_cabal"))
        .args(["arena", "--levels", "grandmaster"])
        .output()
        .unwrap();
    assert_eq!(run.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&run.stderr).contains("unknown level"));
}
