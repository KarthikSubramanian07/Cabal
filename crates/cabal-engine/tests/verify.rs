//! `Game::verify_saved` must notice every kind of tampering, name the phase
//! and the field, and keep going after a difference.

mod common;

use cabal_engine::Game;
use cabal_engine::geo::Map;
use cabal_engine::json::{SavedGame, SavedOutcome};
use cabal_engine::rulebook::Rulebook;
use cabal_engine::verify::{DivergenceField, ReplayReport};

/// A seeded game with retreats and adjustments in it: the first seed that has both.
fn recorded() -> SavedGame {
    static GAME: std::sync::OnceLock<SavedGame> = std::sync::OnceLock::new();
    GAME.get_or_init(|| {
        let saved = (0..200u64)
            .map(|seed| {
                common::playout(Map::standard(), Rulebook::default(), seed, 40).to_saved("verify")
            })
            .find(|saved| {
                saved.phases[6..].iter().any(|p| p.name.ends_with('R'))
                    && saved.phases.iter().any(|p| p.name.ends_with('A'))
                    && saved.phases.last().unwrap().name != "COMPLETED"
            })
            .expect("a seed with a retreat and an adjustment");
        assert!(verify(&saved).is_clean());
        saved
    })
    .clone()
}

fn verify(saved: &SavedGame) -> ReplayReport {
    Game::verify_saved(saved, Rulebook::default()).unwrap()
}

fn index_of(saved: &SavedGame, pick: impl Fn(&str) -> bool) -> usize {
    saved.phases.iter().position(|p| pick(&p.name)).unwrap()
}

/// The report must contain `field` at `phase`, and no divergence anywhere
/// outside `window` (phase names): the replay resynchronises.
fn assert_reported(report: &ReplayReport, field: DivergenceField, phase: &str, window: &[&str]) {
    assert!(
        report
            .divergences
            .iter()
            .any(|d| d.field == field && d.phase == phase),
        "expected {field:?} at {phase}: {:#?}",
        report.divergences
    );
    for d in &report.divergences {
        assert!(
            window.contains(&d.phase.as_str()),
            "divergence leaked to {}: {d}",
            d.phase
        );
    }
}

#[test]
fn a_clean_report_counts_the_phases() {
    let saved = recorded();
    let report = verify(&saved);
    assert!(report.strict);
    assert_eq!(report.phases, saved.phases.len() - 1);
    assert_eq!(report.recorded_by.as_deref(), Some(cabal_engine::VERSION));
    assert_eq!(report.rulebook, "2023");
}

#[test]
fn tampered_orders_are_reported() {
    // The record claims a hold where an illegal move was thrown out. Cabal
    // records what was submitted, so a hold cannot carry the `void` result.
    let map = cabal_engine::geo::Map::standard();
    let mut game = Game::new(map, Rulebook::default());
    let illegal = cabal_engine::parse::parse(map, "FRA: A PAR - MOS")
        .unwrap()
        .to_movement(None)
        .unwrap();
    game.process_movement(&[illegal]);
    let mut saved = game.to_saved("tampered");
    assert!(verify(&saved).is_clean());
    let orders = saved.phases[0].orders.get_mut("FRANCE").unwrap();
    assert!(orders.contains(&"A PAR - MOS".to_string()));
    orders.retain(|o| !o.starts_with("A PAR"));
    orders.push("A PAR H".into());
    let report = verify(&saved);
    assert_reported(&report, DivergenceField::Results, "S1901M", &["S1901M"]);

    // a different legal order shows up in what it did to the board
    let mut saved = recorded();
    let orders = saved.phases[0].orders.get_mut("FRANCE").unwrap();
    orders.retain(|o| !o.starts_with("A PAR"));
    orders.push("A PAR - GAS".into());
    let report = verify(&saved);
    assert_reported(
        &report,
        DivergenceField::Units,
        "S1901M",
        &["S1901M", "F1901M"],
    );

    // and an order that cannot be read is named
    let mut saved = recorded();
    saved.phases[0]
        .orders
        .get_mut("FRANCE")
        .unwrap()
        .push("A PAR - THE MOON".into());
    let report = verify(&saved);
    assert!(
        report
            .divergences
            .iter()
            .any(|d| d.field == DivergenceField::Orders && d.subject == "A PAR - THE MOON"),
        "{:#?}",
        report.divergences
    );
}

#[test]
fn tampered_results_are_reported() {
    let mut saved = recorded();
    let i = index_of(&saved, |n| n.ends_with('M'));
    let phase = saved.phases[i].name.clone();
    let (_, codes) = saved.phases[i].results.iter_mut().next().unwrap();
    *codes = vec!["nonsense".into()];
    assert_reported(&verify(&saved), DivergenceField::Results, &phase, &[&phase]);
}

#[test]
fn tampered_dislodgements_are_reported() {
    let saved = recorded();
    let i = index_of(&saved, |n| n.ends_with('R'));
    let before = saved.phases[i - 1].name.clone();
    let here = saved.phases[i].name.clone();

    // a dislodged unit goes missing from the record
    let mut gone = saved.clone();
    for units in gone.phases[i].state.units.values_mut() {
        units.retain(|u| !u.starts_with('*'));
    }
    let report = verify(&gone);
    assert_reported(
        &report,
        DivergenceField::Dislodged,
        &before,
        &[&before, &here],
    );

    // or the record lies about where the attack came from
    let mut lied = saved.clone();
    let extras = lied.phases[i].state.cabal.as_mut().unwrap();
    extras.dislodged[0].attacker_from = "SWI".into();
    let report = verify(&lied);
    assert!(
        report
            .divergences
            .iter()
            .any(|d| d.field == DivergenceField::Dislodged
                && d.phase == before
                && d.subject == "attackers and standoffs"),
        "{:#?}",
        report.divergences
    );
}

#[test]
fn tampered_phase_names_are_reported() {
    let mut saved = recorded();
    let before = saved.phases[2].name.clone();
    saved.phases[3].name = "W1999A".into();
    saved.phases[3].state.name = "W1999A".into();
    let report = verify(&saved);
    assert!(
        report
            .divergences
            .iter()
            .any(|d| d.field == DivergenceField::PhaseName && d.phase == before),
        "{:#?}",
        report.divergences
    );

    // a label that disagrees with its own state
    let mut saved = recorded();
    saved.phases[3].name = "S1950M".into();
    let report = verify(&saved);
    assert!(
        report
            .divergences
            .iter()
            .any(|d| d.field == DivergenceField::PhaseName && d.subject == "next phase label"),
        "{:#?}",
        report.divergences
    );
}

#[test]
fn tampered_units_are_reported_once_then_the_replay_resynchronises() {
    let mut saved = recorded();
    let units = saved.phases[4].state.units.get_mut("TURKEY").unwrap();
    units.pop();
    let before = saved.phases[3].name.clone();
    let here = saved.phases[4].name.clone();
    let report = verify(&saved);
    assert_reported(&report, DivergenceField::Units, &before, &[&before, &here]);
    assert!(
        report.phases == saved.phases.len() - 1,
        "the whole file was replayed"
    );
}

#[test]
fn tampered_centres_are_reported() {
    let mut saved = recorded();
    let i = index_of(&saved, |n| n.ends_with('A'));
    let before = saved.phases[i - 1].name.clone();
    let here = saved.phases[i].name.clone();
    let stolen = saved.phases[i]
        .state
        .centers
        .get_mut("ITALY")
        .unwrap()
        .pop()
        .unwrap();
    saved.phases[i]
        .state
        .centers
        .get_mut("AUSTRIA")
        .unwrap()
        .push(stolen);
    assert_reported(
        &verify(&saved),
        DivergenceField::Centers,
        &before,
        &[&before, &here],
    );
}

#[test]
fn tampered_retreats_and_builds_are_reported() {
    let saved = recorded();
    let i = index_of(&saved, |n| n.ends_with('R'));
    let before = saved.phases[i - 1].name.clone();
    let mut wider = saved.clone();
    let options = wider.phases[i]
        .state
        .retreats
        .values_mut()
        .flat_map(|m| m.values_mut())
        .next()
        .unwrap();
    options.push("SWI".into());
    let report = verify(&wider);
    assert!(
        report
            .divergences
            .iter()
            .any(|d| d.field == DivergenceField::Retreats && d.phase == before),
        "{:#?}",
        report.divergences
    );

    let i = index_of(&saved, |n| n.ends_with('A'));
    let before = saved.phases[i - 1].name.clone();
    let mut richer = saved.clone();
    richer.phases[i]
        .state
        .builds
        .get_mut("FRANCE")
        .unwrap()
        .count += 3;
    let report = verify(&richer);
    assert!(
        report
            .divergences
            .iter()
            .any(|d| d.field == DivergenceField::Builds
                && d.phase == before
                && d.subject == "FRANCE"),
        "{:#?}",
        report.divergences
    );
}

#[test]
fn a_false_outcome_is_reported() {
    let mut saved = recorded();
    saved.cabal.as_mut().unwrap().outcome = SavedOutcome::Solo {
        winner: "FRANCE".into(),
    };
    let report = verify(&saved);
    assert!(
        report
            .divergences
            .iter()
            .any(|d| d.field == DivergenceField::Outcome),
        "{:#?}",
        report.divergences
    );
}

#[test]
fn anything_else_fails_the_export_comparison() {
    let mut saved = recorded();
    saved.rules = vec!["1971".into()];
    let report = verify(&saved);
    assert_eq!(report.divergences.len(), 1, "{:#?}", report.divergences);
    assert_eq!(report.divergences[0].field, DivergenceField::Export);
    assert_eq!(report.divergences[0].subject, "rules");

    let mut saved = recorded();
    saved.phases[2].messages.push(Default::default());
    saved.phases[2].messages.clear();
    assert!(verify(&saved).is_clean());
}

#[test]
fn files_from_other_tools_are_checked_on_what_they_record() {
    // no cabal block, no implicit holds, no results, powers in any order
    let mut foreign = recorded();
    foreign.cabal = None;
    foreign.rules = vec!["NO_PRESS".into()];
    for phase in &mut foreign.phases {
        phase.state.cabal = None;
        phase.results.clear();
        for orders in phase.orders.values_mut() {
            orders.retain(|o| !o.ends_with(" H"));
            orders.reverse();
        }
        for units in phase.state.units.values_mut() {
            units.reverse();
        }
    }
    let report = verify(&foreign);
    assert!(!report.strict);
    assert!(report.is_clean(), "{:#?}", report.divergences);
    assert_eq!(report.recorded_by, None);

    // but a wrong board is still a wrong board
    let i = index_of(&foreign, |n| n.ends_with('A'));
    foreign.phases[i]
        .state
        .centers
        .get_mut("ITALY")
        .unwrap()
        .pop();
    assert!(
        verify(&foreign)
            .divergences
            .iter()
            .any(|d| d.field == DivergenceField::Centers)
    );
}

#[test]
fn the_report_serialises_for_tools() {
    let mut saved = recorded();
    saved.phases[4].state.units.get_mut("TURKEY").unwrap().pop();
    let json = serde_json::to_value(verify(&saved)).unwrap();
    assert_eq!(json["id"], "verify");
    let first = &json["divergences"][0];
    assert_eq!(first["field"], "units");
    assert_eq!(first["subject"], "TURKEY");
    assert!(first["expected"].is_string() && first["got"].is_string());
}
