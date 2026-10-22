use std::path::Path;

use cabal_engine::Game;
use cabal_engine::geo::Map;
use cabal_engine::order::Order;
use cabal_engine::parse::parse;
use cabal_engine::rulebook::Rulebook;

/// Helper that writes a fixture. Run on demand:
/// cargo test -p cabal-engine --test make_fixture -- --ignored
#[test]
#[ignore]
fn write_opening_fixture() {
    let map = Map::standard();
    let mut g = Game::new(map, Rulebook::default());
    let o = |l: &[&str]| -> Vec<Order> {
        l.iter()
            .map(|s| parse(map, s).unwrap().to_movement(None).unwrap())
            .collect()
    };
    g.process_movement(&o(&[
        "FRA: A PAR - BUR",
        "GER: A MUN - BUR",
        "ENG: F LON - NTH",
        "RUS: F SEV - BLA",
        "TUR: F ANK - BLA",
    ]));
    g.process_movement(&o(&[
        "ENG: F NTH - NWY",
        "RUS: A WAR - GAL",
        "AUS: A BUD - GAL",
    ]));
    let saved = g.to_saved("opening_1901");
    let json = serde_json::to_string_pretty(&saved).unwrap();
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/games/opening_1901.json");
    std::fs::write(path, json).unwrap();
}
