//! Runs the Diplomacy Adjudicator Test Cases v3.0 corpus in `tests/data/datc_v3.json`
//! and Cabal's supplementary cases in `tests/data/cabal_cases.json`.
//!
//! Every case is a separate assertion; the suite fails if any case fails and
//! prints a per-section report so regressions are easy to locate. The checks
//! themselves live in `tests/datc_harness`, shared with `cabal datc`.

mod datc_harness;

use datc_harness::{CABAL_CASES, DATC_V3, render, run_corpus};

#[test]
fn datc_v3_corpus() {
    let report = run_corpus(DATC_V3);
    print!("{}", render("DATC v3.0", &report, true));
    assert_eq!(report.cases.len(), 171, "preserve the original DATC corpus");
    assert_eq!(report.failed(), 0, "{} DATC cases failed", report.failed());
    // The corpus gives no expectation for 336 of its orders (preceding main
    // phases of retreat cases included). The derived checks make up for them:
    // more assertions run than the corpus has orders.
    assert_eq!(report.skipped(), 336);
    assert!(
        report.checks() > 1500,
        "only {} checks ran",
        report.checks()
    );
}

#[test]
fn cabal_supplementary_cases() {
    let report = run_corpus(CABAL_CASES);
    print!("{}", render("Cabal cases", &report, true));
    assert!(report.cases.len() >= 7);
    assert_eq!(report.failed(), 0, "{} Cabal cases failed", report.failed());
}

/// The harness must be able to fail: the same case with a wrong expectation,
/// a wrong standoff list and a wrong dislodgement is reported three times.
#[test]
fn the_harness_notices_wrong_lists() {
    let wrong = r#"{"cases": [{
        "name": "wrong",
        "phase": "Main",
        "orders": {
            "GER: A mun -> tyr": "Succeeds",
            "AUS: A vie -> tyr": "Fails",
            "FRA: A bur -> mun": "Succeeds",
            "FRA: A ruh supports A bur -> mun": "Succeeds"
        },
        "dislodged": [],
        "standoffs": []
    }]}"#;
    let report = run_corpus(wrong);
    assert_eq!(report.failed(), 1);
    let failures = report.cases[0].failures.join("\n");
    assert!(
        failures.contains("GER: A mun -> tyr: expected Succeeds"),
        "{failures}"
    );
    assert!(failures.contains("dislodged: expected {}"), "{failures}");
    assert!(failures.contains("standoffs: expected {}"), "{failures}");
}
