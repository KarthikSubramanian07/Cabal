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
