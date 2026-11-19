//! What a saved game must carry to be reproducible: the rulebook, the outcome,
//! press and pledges, and lossless retreat states. Each test here failed before
//! the `cabal` blocks existed.

mod common;

use cabal_engine::geo::{Map, UnitKind};
use cabal_engine::json::{
    MilaMessage, ReplayError, SavedGame, SavedOutcome, SavedPledge, state_from_mila, state_to_mila,
    state_to_mila_with,
};
use cabal_engine::legal::legal_retreats;
use cabal_engine::order::{AnyOrder, Order, RetreatCommand, Unit};
use cabal_engine::parse::parse;
use cabal_engine::pledge::Receipt;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::{GameState, Phase, PhaseKind, Position, Season};
use cabal_engine::verify::DivergenceField;
use cabal_engine::{Game, Status};

fn movement(map: &Map, lines: &[&str]) -> Vec<Order> {
    lines
        .iter()
        .map(|l| parse(map, l).unwrap().to_movement(None).unwrap())
        .collect()
}

fn through_json(saved: &SavedGame) -> SavedGame {
    serde_json::from_str(&serde_json::to_string(saved).unwrap()).unwrap()
}

/// A board holding exactly the units named, e.g. `GER: A MUN`.
fn board(units: &[&str]) -> Game {
    let map = Map::standard();
    let mut pos = Position::default();
    for text in units {
        let p = parse(map, &format!("{text} H")).unwrap();
        let kind = p.kind.unwrap();
        let region = p.region.unwrap();
        pos.add_unit(Unit {
            power: p.power.unwrap(),
            kind,
            region: if kind == UnitKind::Army {
                cabal_engine::Region::land(region.province)
            } else {
                region
            },
        });
    }
    Game::from_state(
        map,
        Rulebook::default(),
        GameState::from_position(Phase::new(1901, Season::Spring, PhaseKind::Movement), pos),
    )
}

fn retreats_of(game: &Game, state: &GameState, power: &str, from: &str) -> Vec<String> {
    let map = game.map();
    let options = legal_retreats(map, state, map.find_power(power).unwrap());
    let mut out: Vec<String> = options[&map.find_province(from).unwrap()]
        .iter()
        .filter_map(|o| match o.command {
            RetreatCommand::Retreat { dest, .. } => {
                Some(map.province(dest).name.to_ascii_uppercase())
            }
            _ => None,
        })
        .collect();
    out.sort();
    out
}

#[test]
fn a_drawn_game_comes_back_drawn_with_its_members() {
    let map = Map::standard();
    let mut g = Game::new(map, Rulebook::default());
    g.process_movement(&movement(map, &["FRA: A PAR - BUR"]));
    let members = [
        map.find_power("FRANCE").unwrap(),
        map.find_power("TURKEY").unwrap(),
    ];
    g.declare_draw_among(&members);
    let saved = through_json(&g.to_saved("draw"));
    assert_eq!(saved.phases.last().unwrap().name, "COMPLETED");
    assert_eq!(
        saved.cabal.as_ref().unwrap().outcome,
        SavedOutcome::Draw {
            members: vec!["FRANCE".into(), "TURKEY".into()]
        }
    );
    for restored in [
        Game::from_saved(&saved, Rulebook::default()).unwrap(),
        Game::resume(&saved, Rulebook::default()).unwrap(),
    ] {
        assert_eq!(restored.status, Status::Draw);
        assert_eq!(restored.draw_members, members);
        assert_eq!(restored.to_saved("draw"), saved);
    }
}

#[test]
fn a_plain_draw_is_shared_by_the_survivors() {
    let mut g = Game::new(Map::standard(), Rulebook::default());
    g.declare_draw();
    assert_eq!(g.draw_members.len(), 7);
    let SavedOutcome::Draw { members } = g.saved_outcome() else {
        panic!("not a draw");
    };
    assert_eq!(members.len(), 7);
}

#[test]
fn a_file_without_the_cabal_block_still_loads() {
    let map = Map::standard();
    let mut g = Game::new(map, Rulebook::default());
    g.process_movement(&movement(map, &["FRA: A PAR - BUR"]));
    g.declare_draw();
    // as written before the block existed: debug edition name, nothing else
    let mut legacy = g.to_saved("legacy");
    legacy.cabal = None;
    legacy.rules = vec!["E2023".into()];
    let json = serde_json::to_string(&legacy).unwrap();
    assert!(!json.contains("cabal"));
    let legacy: SavedGame = serde_json::from_str(&json).unwrap();

    let replayed = Game::from_saved(&legacy, Rulebook::default()).unwrap();
    assert_eq!(replayed.status, Status::Draw, "COMPLETED without a solo");
    assert_eq!(replayed.state, g.state);
    let resumed = Game::resume(&legacy, Rulebook::default()).unwrap();
    assert_eq!(resumed.status, Status::Draw);
    assert_eq!(resumed.state, g.state);
    assert!(
        Game::verify_saved(&legacy, Rulebook::default())
            .unwrap()
            .is_clean()
    );
}

#[test]
fn the_rulebook_is_recorded_and_restored() {
    let map = Map::standard();
    let mut g = Game::new(map, Rulebook::edition_1971());
    g.process_movement(&movement(map, &["ENG: F LON - NTH"]));
    let saved = through_json(&g.to_saved("1971"));
    assert_eq!(saved.rules, vec!["1971"]);
    assert_eq!(
        Rulebook::by_name(&saved.rules[0]),
        Some(Rulebook::edition_1971())
    );
    // the caller passes the wrong rulebook; the file wins
    let replayed = Game::from_saved(&saved, Rulebook::default()).unwrap();
    assert_eq!(replayed.rulebook, Rulebook::edition_1971());
    assert_eq!(replayed.to_saved("1971"), saved);
    assert_eq!(
        Game::resume(&saved, Rulebook::default()).unwrap().rulebook,
        Rulebook::edition_1971()
    );

    // older files only named the edition, in Rust debug spelling
    let mut legacy = saved.clone();
    legacy.cabal = None;
    legacy.rules = vec!["E1971".into()];
    assert_eq!(
        Game::from_saved(&legacy, Rulebook::default())
            .unwrap()
            .rulebook,
        Rulebook::edition_1971()
    );
    // and a file that says nothing gets the caller's rulebook
    legacy.rules = vec!["NO_PRESS".into()];
    assert_eq!(
        Game::from_saved(&legacy, Rulebook::dptg())
            .unwrap()
            .rulebook,
        Rulebook::dptg()
    );
}

#[test]
fn a_custom_rulebook_survives_in_full() {
    let rulebook = Rulebook {
        victory_centers: 5,
        build_anywhere: true,
        ..Rulebook::edition_1982()
    };
    let g = Game::new(Map::standard(), rulebook);
    let saved = through_json(&g.to_saved("custom"));
    assert_eq!(
        Game::from_saved(&saved, Rulebook::default())
            .unwrap()
            .rulebook,
        rulebook
    );
}

#[test]
fn press_and_pledges_round_trip() {
    let map = Map::standard();
    let mut g = Game::new(map, Rulebook::default());
    let message = |text: &str| MilaMessage {
        sender: "FRANCE".into(),
        recipient: "GERMANY".into(),
        phase: String::new(),
        time_sent: 42,
        message: text.into(),
    };
    g.record_message(message("Burgundy stays empty, agreed?"));
    g.record_pledge(SavedPledge {
        id: "p1".into(),
        phase: "S1901M".into(),
        pledger: "FRANCE".into(),
        audience: "GERMANY".into(),
        sealed: true,
        orders: vec!["A PAR - PIC".into()],
        commitment: Some("ab".repeat(32)),
        nonce: Some("00".repeat(16)),
        receipt: None,
    });
    g.process_movement(&movement(map, &["FRA: A PAR - BUR"]));
    // the receipt arrives after adjudication and replaces the open pledge
    let mut settled = g.pledges[0].clone();
    settled.receipt = Some(Receipt::Broken);
    g.record_pledge(settled);
    g.record_message(message("That was not the plan."));

    let saved = through_json(&g.to_saved("press"));
    assert_eq!(saved.phases[0].messages.len(), 1);
    assert_eq!(saved.phases[0].messages[0].phase, "S1901M");
    assert_eq!(saved.phases[1].messages[0].phase, "F1901M");
    let pledges = &saved.cabal.as_ref().unwrap().pledges;
    assert_eq!(pledges.len(), 1);
    assert_eq!(pledges[0].receipt, Some(Receipt::Broken));

    for restored in [
        Game::from_saved(&saved, Rulebook::default()).unwrap(),
        Game::resume(&saved, Rulebook::default()).unwrap(),
        Game::from_snapshot(&g.snapshot(), Some(&saved)).unwrap(),
    ] {
        assert_eq!(restored.to_saved("press"), saved);
    }
    assert!(
        Game::verify_saved(&saved, Rulebook::default())
            .unwrap()
            .is_clean()
    );
}

#[test]
fn build_sites_follow_the_games_rulebook() {
    let map = Map::by_name("duel").unwrap();
    let red = map.find_power("RED").unwrap();
    let mid = map.find_province("mid").unwrap();
    // Winter: Red owns its home and the middle, stands on its home, and is one
    // unit short. Only a build-anywhere rulebook offers the middle.
    let mut state = GameState::initial(map);
    state.phase = Phase::new(1901, Season::Winter, PhaseKind::Adjustment);
    state.position.owners.insert(mid, red);

    let g = Game::from_state(map, Rulebook::default(), state.clone());
    assert!(g.rulebook.build_anywhere, "the duel map switches it on");
    let saved = g.to_saved("duel");
    let builds = &saved.phases[0].state.builds["RED"];
    assert_eq!(builds.count, 1);
    assert_eq!(builds.homes, vec!["MID"]);
    assert_eq!(
        state_to_mila_with(map, &state, g.rulebook).builds["RED"].homes,
        vec!["MID"]
    );
    // the default-rulebook wrapper cannot know
    assert!(state_to_mila(map, &state).builds["RED"].homes.is_empty());
    assert_eq!(
        Game::from_saved(&saved, Rulebook::edition_1971())
            .unwrap()
            .to_saved("duel"),
        saved
    );
}

/// France takes Munich from Burgundy while Berlin and Warsaw bounce in Silesia.
fn munich_dislodged() -> Game {
    let mut g = board(&[
        "GER: A MUN",
        "GER: A BER",
        "FRA: A BUR",
        "FRA: A RUH",
        "RUS: A WAR",
    ]);
    let map = g.map();
    g.process_movement(&movement(
        map,
        &[
            "FRA: A BUR - MUN",
            "FRA: A RUH S A BUR - MUN",
            "GER: A BER - SIL",
            "RUS: A WAR - SIL",
        ],
    ));
    assert_eq!(g.phase().kind, PhaseKind::Retreat);
    g
}

#[test]
fn a_retreat_state_keeps_the_attacker_origin_and_standoffs() {
    let g = munich_dislodged();
    let map = g.map();
    assert_eq!(
        retreats_of(&g, &g.state, "GER", "mun"),
        vec!["BOH", "KIE", "TYR"]
    );

    // with Cabal's extras the state is exact
    let mila = state_to_mila_with(map, &g.state, g.rulebook);
    let extras = mila.cabal.as_ref().expect("retreat states carry extras");
    assert_eq!(extras.dislodged[0].attacker_from, "BUR");
    assert_eq!(extras.standoffs, vec!["SIL"]);
    assert_eq!(state_from_mila(map, &mila).unwrap(), g.state);

    // without them (a boundary stripped unknown keys) the recorded retreat
    // options still close Burgundy and Silesia
    let mut stripped = mila.clone();
    stripped.cabal = None;
    let approx = state_from_mila(map, &stripped).unwrap();
    assert_eq!(
        retreats_of(&g, &approx, "GER", "mun"),
        vec!["BOH", "KIE", "TYR"]
    );

    // with neither, nothing is known and every vacant neighbour is open
    stripped.retreats.clear();
    let blind = state_from_mila(map, &stripped).unwrap();
    assert_eq!(
        retreats_of(&g, &blind, "GER", "mun"),
        vec!["BOH", "BUR", "KIE", "SIL", "TYR"]
    );
}

#[test]
fn a_save_that_starts_in_a_retreat_phase_replays_correctly() {
    let mut g = munich_dislodged();
    let map = g.map();
    let retreat = parse(map, "GER: A MUN R TYR")
        .unwrap()
        .to_retreat(None)
        .unwrap();
    g.process(&[AnyOrder::Retreat(retreat)]).unwrap();
    let full = g.to_saved("retreat");
    assert_eq!(full.phases[1].orders["GERMANY"], vec!["A MUN R TYR"]);

    let truncated = SavedGame {
        phases: full.phases[1..].to_vec(),
        ..full.clone()
    };
    assert_eq!(truncated.phases[0].name, "S1901R");
    let replayed = Game::from_saved(&through_json(&truncated), Rulebook::default()).unwrap();
    assert_eq!(replayed.state, g.state);
    assert_eq!(replayed.history[0].state, g.history[1].state);
    assert_eq!(replayed.to_saved("retreat"), truncated);

    // an illegal retreat into the attacker's origin is still refused after the reload
    let mut reloaded = Game::resume(
        &SavedGame {
            phases: full.phases[..2].to_vec(),
            ..full.clone()
        },
        Rulebook::default(),
    )
    .unwrap();
    assert_eq!(reloaded.phase().kind, PhaseKind::Retreat);
    let illegal = parse(map, "GER: A MUN R BUR")
        .unwrap()
        .to_retreat(None)
        .unwrap();
    reloaded.process(&[AnyOrder::Retreat(illegal)]).unwrap();
    let germany = map.find_power("GERMANY").unwrap();
    assert_eq!(reloaded.state.position.count_units(germany), 1, "disbanded");
}

#[test]
fn standoffs_do_not_outlive_a_phase_without_retreats() {
    let map = Map::standard();
    let mut g = Game::new(map, Rulebook::default());
    g.process_movement(&movement(map, &["FRA: A PAR - BUR", "GER: A MUN - BUR"]));
    assert_eq!(g.phase().kind, PhaseKind::Movement);
    assert!(g.state.standoffs.is_empty());
    assert!(state_to_mila(map, &g.state).cabal.is_none());
}

#[test]
fn the_solo_goes_to_the_leader_not_the_first_power_past_the_line() {
    let rulebook = Rulebook {
        victory_centers: 4,
        ..Rulebook::default()
    };
    let mut g = board(&["AUS: A SER", "TUR: A BUL", "TUR: A GRE", "TUR: A RUM"]);
    g.rulebook = rulebook;
    let map = g.map();
    let austria = map.find_power("AUSTRIA").unwrap();
    let turkey = map.find_power("TURKEY").unwrap();
    for home in ["bud", "tri", "vie"] {
        g.state
            .position
            .owners
            .insert(map.find_province(home).unwrap(), austria);
    }
    for home in ["ank", "con", "smy"] {
        g.state
            .position
            .owners
            .insert(map.find_province(home).unwrap(), turkey);
    }
    g.state.phase = Phase::new(1901, Season::Fall, PhaseKind::Movement);
    g.process_movement(&[]);
    // Austria reaches 4, Turkey 6: both are past the line, Turkey leads.
    assert_eq!(g.status, Status::Solo { winner: turkey });
}

/// A record made before the standoff fix: Munich and Vienna bounced in Tyrolia,
/// both were dislodged, and the old engine let Munich retreat there.
fn legacy_record_with_the_old_standoff_ruling() -> SavedGame {
    let mut g = board(&[
        "GER: A MUN",
        "AUS: A VIE",
        "FRA: A BUR",
        "FRA: A RUH",
        "RUS: A GAL",
        "RUS: A BUD",
    ]);
    let map = g.map();
    g.process_movement(&movement(
        map,
        &[
            "GER: A MUN - TYR",
            "AUS: A VIE - TYR",
            "FRA: A BUR - MUN",
            "FRA: A RUH S A BUR - MUN",
            "RUS: A GAL - VIE",
            "RUS: A BUD S A GAL - VIE",
        ],
    ));
    let retreat = parse(map, "GER: A MUN R BOH")
        .unwrap()
        .to_retreat(None)
        .unwrap();
    g.process(&[AnyOrder::Retreat(retreat)]).unwrap();
    let mut saved = g.to_saved("legacy-standoff");
    // rewrite it the way the old engine recorded it
    saved.cabal = None;
    saved.rules = vec!["E2023".into()];
    for phase in &mut saved.phases {
        phase.state.cabal = None;
    }
    let retreats = saved.phases[1].state.retreats.get_mut("GERMANY").unwrap();
    retreats.get_mut("A MUN").unwrap().push("TYR".into());
    saved.phases[1]
        .orders
        .insert("GERMANY".into(), vec!["MUN R TYR".into()]);
    for unit in saved.phases[2].state.units.get_mut("GERMANY").unwrap() {
        if unit == "A BOH" {
            *unit = "A TYR".into();
        }
    }
    saved
}

#[test]
fn an_engine_upgrade_cannot_brick_a_recorded_game() {
    let legacy = through_json(&legacy_record_with_the_old_standoff_ruling());

    // re-adjudicating it now disagrees, by design
    assert_eq!(
        Game::from_saved(&legacy, Rulebook::default()).unwrap_err(),
        ReplayError::Diverged {
            phase: "S1901R".into()
        }
    );
    let report = Game::verify_saved(&legacy, Rulebook::default()).unwrap();
    let fields: Vec<_> = report.divergences.iter().map(|d| d.field).collect();
    assert!(fields.contains(&DivergenceField::Retreats), "{report:#?}");
    assert!(fields.contains(&DivergenceField::Units), "{report:#?}");

    // restoring it does not adjudicate the past, so the game carries on
    let mut game = Game::resume(&legacy, Rulebook::default()).unwrap();
    let map = game.map();
    let germany = map.find_power("GERMANY").unwrap();
    let tyrolia = map.find_province("tyr").unwrap();
    assert_eq!(
        game.state.position.unit_at(tyrolia).map(|u| u.power),
        Some(germany),
        "the recorded position is kept"
    );
    assert_eq!(game.phase_count(), 2);
    game.process_movement(&movement(map, &["GER: A TYR - PIE"]));
    let saved = game.to_saved("legacy-standoff");
    assert_eq!(saved.phases[..2], legacy.phases[..2], "history is verbatim");
    assert_eq!(saved.phases.len(), 4);

    // the snapshot path gives the same game
    let again = Game::resume(&legacy, Rulebook::default()).unwrap();
    let restored = Game::from_snapshot(&again.snapshot(), Some(&legacy)).unwrap();
    assert_eq!(restored.state, again.state);
    assert_eq!(restored.archive, again.archive);

    // archived phases can still be inspected
    let record = game.record_at(0).expect("derived on demand");
    assert_eq!(record.state.phase.to_string(), "S1901M");
    assert_eq!(game.state_after(1).unwrap().phase.to_string(), "F1901M");
    assert!(
        game.state_after(1)
            .unwrap()
            .position
            .unit_at(tyrolia)
            .is_some()
    );
}

#[test]
fn golden_playouts_are_deterministic() {
    let a = common::playout(Map::standard(), Rulebook::default(), 7, 30);
    let b = common::playout(Map::standard(), Rulebook::default(), 7, 30);
    assert_eq!(a.to_saved("x"), b.to_saved("x"));
}

/// The server's replay endpoint puts its own summary under the `cabal` key
/// (protocol version, status, pledges, phase summaries). Such a file is a
/// saved game with an annotation, not a broken one.
#[test]
fn a_cabal_key_holding_a_hosts_own_data_does_not_stop_the_file_loading() {
    let map = Map::standard();
    let mut game = Game::new(map, Rulebook::edition_1971());
    game.process_movement(&movement(map, &["FRA: A PAR - BUR"]));
    let mut json = serde_json::to_value(game.to_saved("annotated")).unwrap();
    json["cabal"] = serde_json::json!({
        "protocol": 3,
        "status": "active",
        "finished": null,
        "pledges": [{
            "id": "p1", "pledger": "FRANCE", "audience": "ALL", "phase": "S1901M", "sealed": true,
            "commitment": "ab", "nonce": "cd", "orders": ["A PAR - BUR"], "receipt": "kept",
        }],
        "history": [{ "phase": "S1901M" }],
    });
    let saved: SavedGame = serde_json::from_value(json).unwrap();
    assert!(saved.cabal.is_none(), "a foreign block is read as absent");

    // with no record of its own the edition comes from `rules`, as for any other tool's file
    let replayed = Game::from_saved(&saved, Rulebook::default()).unwrap();
    assert_eq!(replayed.state, game.state);
    assert_eq!(replayed.rulebook, game.rulebook);
    let resumed = Game::resume(&saved, Rulebook::default()).unwrap();
    assert_eq!(resumed.state, game.state);
    let report = Game::verify_saved(&saved, Rulebook::default()).unwrap();
    assert!(report.divergences.is_empty(), "{:?}", report.divergences);
    assert!(!report.strict);

    // the engine's own block still reads back in full
    let own = through_json(&game.to_saved("own"));
    assert!(own.cabal.is_some());
}
