//! A saved game records what was submitted, not what the unit fell back to.
//!
//! An illegal order makes its unit hold. The record used to say the hold was
//! ordered while still marking it `void`, so the engine's own export failed
//! its own verification, and a game resumed from its save reported that the
//! unit had held by choice.

use cabal_engine::geo::Map;
use cabal_engine::json::SavedGame;
use cabal_engine::order::AnyOrder;
use cabal_engine::outcome::{Illegal, OrderOutcome};
use cabal_engine::parse::parse;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::{GameState, Phase, PhaseKind, Position, Season};
use cabal_engine::{Game, PhaseResult};

fn movement(map: &Map, lines: &[&str]) -> Vec<AnyOrder> {
    lines
        .iter()
        .map(|l| AnyOrder::Movement(parse(map, l).unwrap().to_movement(None).unwrap()))
        .collect()
}

fn through_json(saved: &SavedGame) -> SavedGame {
    serde_json::from_str(&serde_json::to_string(saved).unwrap()).unwrap()
}

/// Play one opening phase and return the save as a reader gets it.
fn opening(lines: &[&str]) -> (Game, SavedGame) {
    let map = Map::standard();
    let mut game = Game::new(map, Rulebook::default());
    game.process(&movement(map, lines)).unwrap();
    let saved = through_json(&game.to_saved("record"));
    (game, saved)
}

fn assert_verifies(saved: &SavedGame) {
    let report = Game::verify_saved(saved, Rulebook::default()).unwrap();
    assert!(report.is_clean(), "{:#?}", report.divergences);
    let replayed = Game::from_saved(saved, Rulebook::default()).unwrap();
    assert_eq!(&replayed.to_saved("record"), saved);
}

#[test]
fn an_unreachable_move_is_recorded_as_ordered() {
    let (_, saved) = opening(&["FRA: A PAR - MOS"]);
    let france = &saved.phases[0].orders["FRANCE"];
    assert!(france.contains(&"A PAR - MOS".to_string()), "{france:?}");
    assert!(!france.contains(&"A PAR H".to_string()), "{france:?}");
    assert_eq!(saved.phases[0].results["A PAR"], vec!["void"]);
    assert_verifies(&saved);
}

#[test]
fn every_line_of_a_duplicate_is_recorded() {
    let (_, saved) = opening(&["FRA: A PAR - BUR", "FRA: A PAR - PIC"]);
    let france = &saved.phases[0].orders["FRANCE"];
    assert!(france.contains(&"A PAR - BUR".to_string()), "{france:?}");
    assert!(france.contains(&"A PAR - PIC".to_string()), "{france:?}");
    assert_eq!(saved.phases[0].results["A PAR"], vec!["void"]);
    assert_verifies(&saved);
}

#[test]
fn an_order_for_a_rivals_unit_is_recorded_under_its_sender() {
    // alone, and next to the owner's own order, which must stand
    let (_, saved) = opening(&["GER: A PAR - BUR"]);
    assert_eq!(saved.phases[0].orders["GERMANY"][0], "A PAR - BUR");
    assert_eq!(saved.phases[0].results["A PAR"], vec!["void"]);
    assert_verifies(&saved);

    let (_, saved) = opening(&["GER: A PAR - BUR", "FRA: A PAR - PIC"]);
    assert_eq!(saved.phases[0].orders["GERMANY"][0], "A PAR - BUR");
    assert!(saved.phases[0].orders["FRANCE"].contains(&"A PAR - PIC".to_string()));
    assert!(saved.phases[0].results["A PAR"].is_empty());
    assert_verifies(&saved);
}

#[test]
fn an_illegal_support_and_an_order_for_nothing_are_recorded() {
    let (_, saved) = opening(&["FRA: A MAR S A PAR - MOS", "FRA: A BUR - MUN"]);
    let france = &saved.phases[0].orders["FRANCE"];
    assert!(
        france.contains(&"A MAR S A PAR - MOS".to_string()),
        "{france:?}"
    );
    // nothing stands in Burgundy; the line is kept as it can be written
    assert!(france.contains(&"BUR - MUN".to_string()), "{france:?}");
    assert_verifies(&saved);
}

#[test]
fn a_past_ruling_reads_the_same_after_resume() {
    let map = Map::standard();
    let (game, saved) = opening(&["FRA: A PAR - MOS", "FRA: A MAR - SPA", "FRA: A MAR - BUR"]);
    let resumed = Game::resume(&saved, Rulebook::default()).unwrap();
    let before = game.record_at(0).unwrap();
    let after = resumed.record_at(0).unwrap();
    assert_eq!(after.result, before.result);
    let PhaseResult::Movement(ruling) = &after.result else {
        panic!("a movement phase")
    };
    let at = |name: &str| ruling.outcome_at(map.find_province(name).unwrap());
    assert!(matches!(
        at("par"),
        Some(OrderOutcome::Illegal {
            reason: Illegal::Unreachable,
            ..
        })
    ));
    assert!(matches!(
        at("mar"),
        Some(OrderOutcome::Illegal {
            reason: Illegal::DuplicateOrder,
            ..
        })
    ));
}

/// France's army in Munich is dislodged from Burgundy and may retreat.
fn dislodged_in_munich() -> Game {
    use cabal_engine::geo::{Region, UnitKind};
    let map = Map::standard();
    let id = |n: &str| map.find_province(n).unwrap();
    let power = |n: &str| map.find_power(n).unwrap();
    let mut pos = Position::default();
    pos.set_unit(power("FRANCE"), UnitKind::Army, Region::land(id("mun")));
    pos.set_unit(power("GERMANY"), UnitKind::Army, Region::land(id("bur")));
    pos.set_unit(power("GERMANY"), UnitKind::Army, Region::land(id("ruh")));
    let state =
        GameState::from_position(Phase::new(1901, Season::Spring, PhaseKind::Movement), pos);
    let mut game = Game::from_state(map, Rulebook::default(), state);
    game.process(&movement(
        map,
        &["GER: A BUR - MUN", "GER: A RUH S A BUR - MUN"],
    ))
    .unwrap();
    assert_eq!(game.phase().kind, PhaseKind::Retreat);
    game
}

fn retreats(map: &Map, lines: &[&str]) -> Vec<AnyOrder> {
    lines
        .iter()
        .map(|l| AnyOrder::Retreat(parse(map, l).unwrap().to_retreat(None).unwrap()))
        .collect()
}

#[test]
fn retreat_orders_that_did_not_count_are_recorded_too() {
    let map = Map::standard();

    // a rival's order for the unit is ignored and kept under the rival
    let mut game = dislodged_in_munich();
    game.process(&retreats(map, &["FRA: A MUN R TYR", "GER: A MUN D"]))
        .unwrap();
    let saved = through_json(&game.to_saved("record"));
    assert_eq!(saved.phases[1].orders["FRANCE"], vec!["A MUN R TYR"]);
    assert_eq!(saved.phases[1].orders["GERMANY"], vec!["A MUN D"]);
    assert!(saved.phases[1].results["A MUN"].is_empty());
    assert_verifies(&saved);

    // two orders from the owner disband the unit; both lines are kept
    let mut game = dislodged_in_munich();
    game.process(&retreats(map, &["FRA: A MUN R TYR", "FRA: A MUN R BOH"]))
        .unwrap();
    let saved = through_json(&game.to_saved("record"));
    assert_eq!(
        saved.phases[1].orders["FRANCE"],
        vec!["A MUN R TYR", "A MUN R BOH"]
    );
    assert_eq!(saved.phases[1].results["A MUN"], vec!["disband"]);
    assert_verifies(&saved);
}

#[test]
fn adjustment_orders_without_a_unit_can_be_read_back() {
    let map = Map::standard();
    let state = GameState::from_position(
        Phase::new(1901, Season::Winter, PhaseKind::Adjustment),
        Position::initial(map),
    );
    let mut game = Game::from_state(map, Rulebook::default(), state);
    let orders: Vec<AnyOrder> = ["FRA: BUR D", "FRA: SPA B", "FRA: WAIVE", "GER: WAIVE"]
        .iter()
        .map(|l| AnyOrder::Adjustment(parse(map, l).unwrap().to_adjustment(None).unwrap()))
        .collect();
    game.process(&orders).unwrap();
    let saved = through_json(&game.to_saved("record"));
    assert_eq!(
        saved.phases[0].orders["FRANCE"],
        vec!["BUR D", "SPA B", "WAIVE"]
    );
    assert_eq!(saved.phases[0].results["BUR"], vec!["void"]);
    assert_eq!(saved.phases[0].results["WAIVE"], vec!["void"]);
    assert_verifies(&saved);
}
