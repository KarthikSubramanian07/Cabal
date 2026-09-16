//! `cabal`: command line tools for the Cabal engine.
//!
//! ```text
//! cabal datc [--report]                 run the DATC v3.0 corpus and print a section report
//! cabal explain <order>...              adjudicate a movement phase from order text and explain it
//! cabal legal <power> [<order>...]      list legal orders for a power (after optional setup orders)
//! cabal replay <saved-game.json>        replay a MILA saved game through the engine
//! cabal version
//! ```

use std::collections::BTreeMap;
use std::process::ExitCode;

use cabal_engine::adjudicate::movement::resolve_movement;
use cabal_engine::geo::Map;
use cabal_engine::json::SavedGame;
use cabal_engine::order::{Order, Unit};
use cabal_engine::outcome::OrderOutcome;
use cabal_engine::parse::parse;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::Position;
use cabal_engine::text::order_text;
use cabal_engine::{Game, VERSION};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("datc") => datc(),
        Some("explain") => explain(&args[1..]),
        Some("legal") => legal(&args[1..]),
        Some("replay") => replay(&args[1..]),
        Some("version") | None => {
            println!("cabal {VERSION}");
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("unknown subcommand: {other}");
            eprintln!("usage: cabal <datc|explain|legal|replay|version> ...");
            ExitCode::from(2)
        }
    }
}

/// Build a position from order text: every ordered unit is placed where its order says it is.
fn position_from_orders(map: &Map, lines: &[String]) -> Result<(Position, Vec<Order>), String> {
    let mut pos = Position::default();
    let mut orders = Vec::new();
    for line in lines {
        let p = parse(map, line).map_err(|e| format!("{line}: {e}"))?;
        let (Some(power), Some(kind), Some(region)) = (p.power, p.kind, p.region) else {
            return Err(format!(
                "{line}: power, unit kind and location are all required"
            ));
        };
        let region = if kind == cabal_engine::UnitKind::Army {
            cabal_engine::Region::land(region.province)
        } else {
            region
        };
        if pos.unit_at(region.province).is_none() {
            pos.add_unit(Unit {
                power,
                kind,
                region,
            });
        }
        orders.push(p.to_movement(None).map_err(|e| format!("{line}: {e}"))?);
    }
    Ok((pos, orders))
}

fn explain(lines: &[String]) -> ExitCode {
    let map = Map::standard();
    let (pos, orders) = match position_from_orders(map, lines) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let result = resolve_movement(map, &pos, Rulebook::default(), &orders);
    for (o, out) in result.orders.iter().zip(&result.outcomes) {
        let mark = if out.succeeds() { "ok " } else { "no " };
        println!(
            "{mark} {:<26} {}",
            order_text(map, &pos, o),
            describe(map, out)
        );
    }
    for d in &result.dislodged {
        println!(
            "dislodged: {} (attacked from {})",
            cabal_engine::text::unit_text(map, &d.unit),
            map.province(d.attacker_from).name.to_ascii_uppercase()
        );
    }
    if !result.standoffs.is_empty() {
        let names: Vec<String> = result
            .standoffs
            .iter()
            .map(|&p| map.province(p).name.to_ascii_uppercase())
            .collect();
        println!("standoffs: {}", names.join(", "));
    }
    ExitCode::SUCCESS
}

fn describe(map: &Map, out: &OrderOutcome) -> String {
    cabal_engine::text::describe_outcome(map, out)
}

fn legal(args: &[String]) -> ExitCode {
    let map = Map::standard();
    let Some(power_name) = args.first() else {
        eprintln!("usage: cabal legal <power> [<setup order>...]");
        return ExitCode::from(2);
    };
    let Some(power) = map.find_power(power_name) else {
        eprintln!("unknown power {power_name}");
        return ExitCode::from(2);
    };
    let pos = if args.len() > 1 {
        match position_from_orders(map, &args[1..]) {
            Ok((p, _)) => p,
            Err(e) => {
                eprintln!("{e}");
                return ExitCode::from(2);
            }
        }
    } else {
        Position::initial(map)
    };
    let legal = cabal_engine::legal::legal_movement(map, &pos, power);
    let mut total = 0;
    for (_, orders) in legal {
        for o in orders {
            println!("{}", order_text(map, &pos, &o));
            total += 1;
        }
    }
    eprintln!("{total} legal orders");
    ExitCode::SUCCESS
}

fn replay(args: &[String]) -> ExitCode {
    let Some(path) = args.first() else {
        eprintln!("usage: cabal replay <saved-game.json>");
        return ExitCode::from(2);
    };
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            return ExitCode::from(2);
        }
    };
    let saved: SavedGame = match serde_json::from_str(&text) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cannot parse {path}: {e}");
            return ExitCode::from(2);
        }
    };
    match Game::from_saved(&saved, Rulebook::default()) {
        Ok(game) => {
            println!(
                "replayed {} phases, now at {} ({:?})",
                game.history.len(),
                game.phase(),
                game.status
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("replay failed: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Run the DATC corpus shipped with the engine and print a section report.
fn datc() -> ExitCode {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../../cabal-engine/tests/data/datc_v3.json"))
            .expect("corpus");
    let cases = corpus["cases"].as_array().expect("cases");
    let mut by_section: BTreeMap<String, usize> = BTreeMap::new();
    for c in cases {
        let name = c["name"].as_str().unwrap_or("");
        let section = name.get(2..3).unwrap_or("?").to_ascii_uppercase();
        *by_section.entry(section).or_default() += 1;
    }
    println!("DATC v3.0 corpus: {} cases", cases.len());
    for (s, n) in &by_section {
        println!("  6.{s}: {n}");
    }
    println!("run `cargo test -p cabal-engine --test datc -- --nocapture` for pass/fail detail");
    ExitCode::SUCCESS
}
