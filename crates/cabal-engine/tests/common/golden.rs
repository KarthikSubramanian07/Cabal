//! Tier two of the replay fixtures: golden games, generated and committed.
//!
//! Every game here is produced by code in this file, from a script or from a
//! seed, so its provenance is exact. The committed files pin today's rulings:
//! `tests/replay.rs` fails when the engine no longer writes the same bytes.
//! After an intended rules change, regenerate with
//!
//! ```text
//! UPDATE_FIXTURES=1 cargo test -p cabal-engine --test replay
//! ```
//!
//! and review the diff: it shows exactly which recorded rulings moved.

use std::collections::BTreeSet;

use cabal_engine::Game;
use cabal_engine::geo::{Map, UnitKind};
use cabal_engine::json::{MilaMessage, SavedGame, SavedPledge};
use cabal_engine::order::{AnyOrder, Unit};
use cabal_engine::parse::parse;
use cabal_engine::pledge::{self, Receipt};
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::{GameState, Phase, PhaseKind, Position, Season};

use super::{Rng, features, play, playout, random_game};

pub struct Golden {
    /// File stem under `tests/data/games/generated/`.
    pub name: &'static str,
    /// How the game was made, for the manifest.
    pub source: String,
    pub saved: SavedGame,
}

/// Process one phase from order text (`FRA: A PAR - BUR`, `GER: A MUN R BOH`, `ENG: F LON B`).
fn step(game: &mut Game, lines: &[&str]) {
    let map = game.map();
    let orders: Vec<AnyOrder> = lines
        .iter()
        .map(|line| {
            let parsed = parse(map, line).unwrap_or_else(|e| panic!("{line}: {e}"));
            match game.phase().kind {
                PhaseKind::Movement => parsed.to_movement(None).map(AnyOrder::Movement),
                PhaseKind::Retreat => parsed.to_retreat(None).map(AnyOrder::Retreat),
                PhaseKind::Adjustment => parsed.to_adjustment(None).map(AnyOrder::Adjustment),
            }
            .unwrap_or_else(|e| panic!("{line}: {e}"))
        })
        .collect();
    game.process(&orders).unwrap();
}

/// A standard-map game starting from exactly the units named (`GER: A MUN`).
fn from_units(units: &[&str]) -> Game {
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

fn opening_1901() -> Game {
    let mut g = Game::new(Map::standard(), Rulebook::default());
    step(
        &mut g,
        &[
            "FRA: A PAR - BUR",
            "GER: A MUN - BUR",
            "ENG: F LON - NTH",
            "RUS: F SEV - BLA",
            "TUR: F ANK - BLA",
        ],
    );
    step(
        &mut g,
        &["ENG: F NTH - NWY", "RUS: A WAR - GAL", "AUS: A BUD - GAL"],
    );
    g
}

/// Munich and Vienna bounce in Tyrolia while both are dislodged; Tyrolia is a
/// standoff, and their retreats then collide in Bohemia.
fn standoff_retreats() -> Game {
    let mut g = from_units(&[
        "GER: A MUN",
        "AUS: A VIE",
        "FRA: A BUR",
        "FRA: A RUH",
        "RUS: A GAL",
        "RUS: A BUD",
    ]);
    step(
        &mut g,
        &[
            "GER: A MUN - TYR",
            "AUS: A VIE - TYR",
            "FRA: A BUR - MUN",
            "FRA: A RUH S A BUR - MUN",
            "RUS: A GAL - VIE",
            "RUS: A BUD S A GAL - VIE",
        ],
    );
    step(&mut g, &["GER: A MUN R BOH", "AUS: A VIE R BOH"]);
    step(&mut g, &["FRA: A MUN - TYR", "RUS: A VIE - TYR"]);
    g
}

/// A convoy to Norway, split coasts in Spain and St Petersburg, a waived build.
fn convoy_and_coasts() -> Game {
    let mut g = Game::new(Map::standard(), Rulebook::default());
    step(
        &mut g,
        &[
            "ENG: F LON - NTH",
            "ENG: A LVP - YOR",
            "ENG: F EDI - NWG",
            "FRA: F BRE - MAO",
            "FRA: A MAR - SPA",
            "FRA: A PAR - BUR",
            "RUS: F STP/SC - BOT",
            "RUS: A MOS - STP",
        ],
    );
    step(
        &mut g,
        &[
            "ENG: F NTH C A YOR - NWY",
            "ENG: A YOR - NWY VIA",
            "ENG: F NWG S A YOR - NWY",
            "FRA: F MAO - POR",
            "RUS: F BOT - SWE",
            "RUS: A STP - FIN",
        ],
    );
    assert_eq!(g.phase().to_string(), "W1901A");
    step(
        &mut g,
        &[
            "ENG: F LON B",
            "FRA: F BRE B",
            "FRA: WAIVE",
            "RUS: F STP/NC B",
        ],
    );
    step(
        &mut g,
        &[
            "FRA: A SPA - MAR",
            "FRA: F POR - SPA/SC",
            "RUS: F STP/NC - BAR",
            "ENG: F NWG - BAR",
        ],
    );
    g
}

/// The first seed whose game has every tag in `wanted`.
fn seed_with(wanted: &[&str], make: impl Fn(u64) -> Game) -> (u64, Game) {
    (0..2000u64)
        .map(|seed| (seed, make(seed)))
        .find(|(_, game)| {
            let tags = features(game, &game.to_saved(""));
            wanted.iter().all(|w| tags.contains(*w))
        })
        .unwrap_or_else(|| panic!("no seed below 2000 covers {wanted:?}"))
}

/// France pledges publicly, keeps one pledge and breaks the next; the receipts
/// are computed by the engine and recorded with the game, which ends in a draw.
fn pledges_and_draw() -> Game {
    let map = Map::standard();
    let france = map.find_power("FRANCE").unwrap();
    let mut g = Game::new(map, Rulebook::default());
    let say = |g: &mut Game, from: &str, to: &str, at: u64, text: &str| {
        g.record_message(MilaMessage {
            sender: from.into(),
            recipient: to.into(),
            phase: String::new(),
            time_sent: at,
            message: text.into(),
        });
    };
    let pledge = |g: &mut Game, id: &str, promised: &[&str], submitted: &[&str]| {
        let promised: Vec<String> = promised.iter().map(|s| s.to_string()).collect();
        let submitted: Vec<String> = submitted.iter().map(|s| s.to_string()).collect();
        let orders = pledge::check(map, &g.state, france, &promised).unwrap();
        let nonce = [id.len() as u8; 16];
        let receipt = pledge::receipt_for(map, &g.state, france, &orders, &submitted);
        g.record_pledge(SavedPledge {
            id: id.into(),
            phase: g.phase().to_string(),
            pledger: "FRANCE".into(),
            audience: "GERMANY".into(),
            sealed: true,
            commitment: Some(pledge::commit(&orders, &nonce)),
            nonce: Some(nonce.iter().map(|b| format!("{b:02x}")).collect()),
            orders,
            receipt: Some(receipt),
        });
        receipt
    };

    say(
        &mut g,
        "FRANCE",
        "GERMANY",
        1,
        "Burgundy stays empty. Sealed.",
    );
    let kept = pledge(
        &mut g,
        "seal-1",
        &["A PAR - PIC"],
        &["A PAR - PIC", "A MAR - SPA", "F BRE - MAO"],
    );
    assert_eq!(kept, Receipt::Kept);
    step(
        &mut g,
        &[
            "FRA: A PAR - PIC",
            "FRA: A MAR - SPA",
            "FRA: F BRE - MAO",
            "GER: A MUN - RUH",
        ],
    );
    say(&mut g, "GERMANY", "FRANCE", 2, "Kept. Same again?");
    say(&mut g, "FRANCE", "GERMANY", 3, "Same again. Sealed.");
    let broken = pledge(
        &mut g,
        "seal-2",
        &["A PIC - BEL"],
        &["A PIC - BUR", "F MAO - POR"],
    );
    assert_eq!(broken, Receipt::Broken);
    step(
        &mut g,
        &["FRA: A PIC - BUR", "FRA: F MAO - POR", "GER: A RUH - BEL"],
    );
    say(&mut g, "GERMANY", "ALL", 4, "France breaks seals.");
    step(&mut g, &["FRA: A PAR B", "FRA: F BRE B", "GER: A MUN B"]);
    play(&mut g, &mut Rng::new(1901), 9);
    g.declare_draw();
    g
}

/// Every golden game, in the order they are listed in the manifest.
pub fn golden_games() -> Vec<Golden> {
    let standard = Map::standard();
    let mut out: Vec<Golden> = Vec::new();
    let mut add = |name: &'static str, source: String, game: &Game| {
        out.push(Golden {
            name,
            source,
            saved: game.to_saved(name),
        });
    };

    add(
        "opening_1901",
        "scripted: two movement phases with bounces".into(),
        &opening_1901(),
    );
    let standoff = standoff_retreats();
    add(
        "standoff_retreats",
        "scripted: custom start; both bouncing units dislodged, retreats collide".into(),
        &standoff,
    );
    add(
        "convoy_and_coasts",
        "scripted: convoy, split coasts, a coastal build, a waive".into(),
        &convoy_and_coasts(),
    );
    add(
        "pledges_and_draw",
        "scripted opening with press, a kept and a broken seal; seed 1901 for 9 phases; draw"
            .into(),
        &pledges_and_draw(),
    );

    let (seed, game) = seed_with(&["civil_disorder", "retreat", "rulebook:1971"], |seed| {
        playout(standard, Rulebook::edition_1971(), seed, 40)
    });
    add(
        "civil_disorder_1971",
        format!("seeded: 1971 rulebook, seed {seed}, 40 phases"),
        &game,
    );

    let short = Rulebook {
        victory_centers: 7,
        ..Rulebook::default()
    };
    let (seed, game) = seed_with(&["solo"], |seed| playout(standard, short, seed, 60));
    add(
        "short_victory_solo",
        format!("seeded: victory at 7 centres, seed {seed}, played to the solo"),
        &game,
    );

    let (seed, game) = seed_with(&["solo", "bounce"], |seed| {
        playout(Map::by_name("duel").unwrap(), Rulebook::default(), seed, 30)
    });
    add(
        "duel_build_anywhere",
        format!("seeded: duel map, seed {seed}, played to the solo"),
        &game,
    );

    let (seed, game) = seed_with(
        &["retreat", "retreat_disband", "build", "disband"],
        |seed| random_game(standard, "dptg", seed, 40, false),
    );
    add(
        "dptg_with_press",
        format!("seeded: DPTG rulebook, random press and pledges, seed {seed}, 40 phases"),
        &game,
    );

    let (seed, game) = seed_with(&["retreat", "support", "elimination"], |seed| {
        playout(standard, Rulebook::edition_1982(), seed, 70)
    });
    add(
        "elimination_1982",
        format!("seeded: 1982 rulebook, seed {seed}, 70 phases"),
        &game,
    );

    // the standoff game again, as a save that begins in its retreat phase
    let full = standoff.to_saved("retreat_start");
    let truncated = SavedGame {
        phases: full.phases[1..].to_vec(),
        ..full
    };
    out.push(Golden {
        name: "retreat_start",
        source: "scripted: standoff_retreats cut to begin in its retreat phase".into(),
        saved: truncated,
    });
    out
}

/// One phase per line: small on disk and reviewable as a diff.
pub fn to_file_text(saved: &SavedGame) -> String {
    let mut text = String::from("{\n");
    text += &format!("\"id\": {},\n", serde_json::to_string(&saved.id).unwrap());
    text += &format!("\"map\": {},\n", serde_json::to_string(&saved.map).unwrap());
    text += &format!(
        "\"rules\": {},\n",
        serde_json::to_string(&saved.rules).unwrap()
    );
    text += "\"phases\": [\n";
    let phases: Vec<String> = saved
        .phases
        .iter()
        .map(|p| serde_json::to_string(p).unwrap())
        .collect();
    text += &phases.join(",\n");
    text += "\n]";
    if let Some(meta) = &saved.cabal {
        text += &format!(",\n\"cabal\": {}", serde_json::to_string(meta).unwrap());
    }
    text += "\n}\n";
    text
}

/// Tags a saved game covers, by replaying it.
pub fn covers(saved: &SavedGame) -> BTreeSet<String> {
    let game = Game::from_saved(saved, Rulebook::default()).expect("fixture replays");
    features(&game, saved)
}
