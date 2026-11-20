//! `cabal datc` adjudicates the corpus: it is the gate CI prints, so it must
//! report real totals and fail when a case fails.

use std::process::Command;

fn datc(args: &[&str]) -> (Option<i32>, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_cabal"))
        .arg("datc")
        .args(args)
        .output()
        .unwrap();
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    )
}

#[test]
fn report_adjudicates_every_case_and_prints_totals() {
    let (code, text) = datc(&["--report"]);
    assert_eq!(code, Some(0), "{text}");
    assert!(
        text.contains("DATC v3.0: 171 cases, 171 passed, 0 failed;"),
        "{text}"
    );
    assert!(text.contains("orders skipped"), "{text}");
    for section in ["6.A:", "6.E:", "6.G:", "6.H:", "6.J:", "cabal:"] {
        assert!(text.contains(section), "{section} missing from:\n{text}");
    }
    assert!(
        text.contains("Cabal cases: 7 cases, 7 passed, 0 failed;"),
        "{text}"
    );
    let total = text.lines().last().unwrap();
    assert!(
        total.starts_with("total: 178 passed, 0 failed, "),
        "{total}"
    );
    assert!(total.ends_with(" skipped"), "{total}");
}

#[test]
fn the_summary_omits_the_section_table() {
    let (code, text) = datc(&[]);
    assert_eq!(code, Some(0));
    assert!(text.contains("171 passed"));
    assert!(!text.contains("6.A:"), "{text}");
    assert_eq!(datc(&["--nonsense"]).0, Some(2));
}

#[test]
fn json_reports_every_case_passed_and_none_skipped() {
    let (code, text) = datc(&["--json"]);
    assert_eq!(code, Some(0), "{text}");
    let report: serde_json::Value = serde_json::from_str(&text).expect("one JSON document");
    let corpus = &report["corpora"][0];
    assert_eq!(corpus["name"], "DATC v3.0");
    assert_eq!(corpus["total"], 171);
    assert_eq!(corpus["passed"], corpus["total"], "{text}");
    assert_eq!(corpus["failed"], 0);
    assert_eq!(corpus["skipped"], 0);
    assert!(corpus["checks"].as_u64().unwrap() > 171);
    assert_eq!(report["skipped"], 0);
    assert_eq!(report["failed"], 0);
    assert_eq!(report["passed"], report["total"]);
    assert_eq!(report["total"], 178);
    assert!(report["engine"].as_str().is_some_and(|v| !v.is_empty()));
    // `--json` with `--report` is still one document; nonsense is still refused.
    let (code, both) = datc(&["--json", "--report"]);
    assert_eq!(code, Some(0));
    assert!(
        serde_json::from_str::<serde_json::Value>(&both).is_ok(),
        "{both}"
    );
}
