//! `cabal`: command line tools for the Cabal engine.
//!
//! ```text
//! cabal datc [--report] [--json]        adjudicate the DATC v3.0 corpus; pass, fail and skip totals (exit 1 on any failure or skipped case)
//! cabal explain [--graph] <order>...              adjudicate a movement phase from order text and explain it
//! cabal legal <power> [<order>...]      list legal orders for a power (after optional setup orders)
//! cabal replay [--json] <file|dir>...   replay saved games and report every divergence (exit 1 on any)
//! cabal arena [--games N] ...           bot against bot on every core (see `arena.rs`)
//! cabal version
//! ```

mod arena;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use cabal_engine::adjudicate::movement::{explain_movement, resolve_movement_with_dependencies};
use cabal_engine::geo::Map;
use cabal_engine::json::SavedGame;
use cabal_engine::order::{Order, Unit};
use cabal_engine::outcome::OrderOutcome;
use cabal_engine::parse::parse;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::Position;
use cabal_engine::text::{explain_sentence, order_text};
use cabal_engine::{Game, VERSION};

/// The conformance harness is the one `cargo test` runs, compiled in from the
/// engine's test directory so the two can never disagree.
#[path = "../../cabal-engine/tests/datc_harness/mod.rs"]
mod datc_harness;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("datc") => datc(&args[1..]),
        Some("explain") => explain(&args[1..]),
        Some("legal") => legal(&args[1..]),
        Some("replay") => replay(&args[1..]),
        Some("arena") => arena::run(&args[1..]),
        Some("version") | None => {
            println!(
                "cabal {VERSION} ({}, {} opt-level {}, {})",
                cabal_engine::build::COMMIT,
                cabal_engine::build::PROFILE,
                cabal_engine::build::OPT_LEVEL,
                cabal_engine::build::TARGET
            );
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("unknown subcommand: {other}");
            eprintln!("usage: cabal <datc|explain|legal|replay|arena|version> ...");
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
    let graph = lines.iter().any(|line| line == "--graph");
    let lines: Vec<String> = lines
        .iter()
        .filter(|line| line.as_str() != "--graph")
        .cloned()
        .collect();
    let map = Map::standard();
    let (pos, orders) = match position_from_orders(map, &lines) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    if graph {
        let (_, dependencies) =
            resolve_movement_with_dependencies(map, &pos, Rulebook::default(), &orders);
        print!("{}", dependencies.to_dot(map, &pos));
        return ExitCode::SUCCESS;
    }
    let (result, explanation) = explain_movement(map, &pos, Rulebook::default(), &orders);
    for (i, (o, out)) in result.orders.iter().zip(&result.outcomes).enumerate() {
        let mark = if out.succeeds() { "ok " } else { "no " };
        println!(
            "{mark} {:<26} {}",
            order_text(map, &pos, o),
            describe(map, &pos, out)
        );
        if !out.succeeds() {
            // the full sentence, with strengths and the units responsible
            let submitted = orders
                .iter()
                .find(|s| s.unit == o.unit)
                .map(|s| order_text(map, &pos, s));
            println!(
                "       {}",
                explain_sentence(map, &pos, &explanation, i, submitted.as_deref())
            );
        }
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

fn describe(map: &Map, pos: &Position, out: &OrderOutcome) -> String {
    cabal_engine::text::describe_outcome_in(map, pos, out)
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

/// Every `.json` file under `path`, sorted, skipping the fixture manifest.
fn saved_game_files(path: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if path.is_dir() {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(path)?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|e| e.path())
            .collect();
        entries.sort();
        for entry in entries {
            let is_json = entry.extension().is_some_and(|e| e == "json");
            let is_manifest = entry.file_name().is_some_and(|n| n == "manifest.json");
            if entry.is_dir() || (is_json && !is_manifest) {
                saved_game_files(&entry, out)?;
            }
        }
    } else {
        out.push(path.to_path_buf());
    }
    Ok(())
}

/// Replay saved games and report every divergence from the record.
///
/// Exit status: 0 when every game replays with zero divergences, 1 when any
/// diverges, 2 when a path cannot be read or is not a saved game.
fn replay(args: &[String]) -> ExitCode {
    const USAGE: &str = "usage: cabal replay [--json] [--rulebook <2023|1982|1971|dptg>] <saved-game.json | directory>...";
    let mut json = false;
    let mut rulebook = Rulebook::default();
    let mut paths: Vec<&String> = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => json = true,
            "--rulebook" => match it.next().and_then(|name| Rulebook::by_name(name)) {
                Some(r) => rulebook = r,
                None => {
                    eprintln!("--rulebook needs one of 2023, 1982, 1971, dptg");
                    return ExitCode::from(2);
                }
            },
            flag if flag.starts_with("--") => {
                eprintln!("unknown option {flag}\n{USAGE}");
                return ExitCode::from(2);
            }
            _ => paths.push(arg),
        }
    }
    if paths.is_empty() {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }
    let mut files = Vec::new();
    for path in paths {
        let before = files.len();
        if let Err(e) = saved_game_files(Path::new(path), &mut files) {
            eprintln!("cannot read {path}: {e}");
            return ExitCode::from(2);
        }
        if files.len() == before {
            eprintln!("no saved games under {path}");
            return ExitCode::from(2);
        }
    }

    let mut reports = Vec::new();
    let mut unreadable = 0;
    let mut diverged = 0;
    let mut phases = 0;
    for file in &files {
        let name = file.display();
        let report = std::fs::read_to_string(file)
            .map_err(|e| format!("cannot read: {e}"))
            .and_then(|text| {
                serde_json::from_str::<SavedGame>(&text)
                    .map_err(|e| format!("not a saved game: {e}"))
            })
            .and_then(|saved| Game::verify_saved(&saved, rulebook).map_err(|e| e.to_string()));
        match report {
            Ok(report) => {
                phases += report.phases;
                if !report.is_clean() {
                    diverged += 1;
                }
                if !json {
                    println!(
                        "{name}: {} phases, {} divergences",
                        report.phases,
                        report.divergences.len()
                    );
                    for d in &report.divergences {
                        println!("  {d}");
                    }
                }
                reports.push(serde_json::json!({ "file": name.to_string(), "report": report }));
            }
            Err(e) => {
                unreadable += 1;
                if !json {
                    println!("{name}: error: {e}");
                }
                reports.push(serde_json::json!({ "file": name.to_string(), "error": e }));
            }
        }
    }
    if json {
        let all = serde_json::json!({
            "engine": VERSION,
            "games": files.len(),
            "phases": phases,
            "diverged": diverged,
            "unreadable": unreadable,
            "reports": reports,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&all).expect("report serialises")
        );
    } else {
        println!(
            "{} games, {phases} phases, {diverged} diverged, {unreadable} unreadable",
            files.len()
        );
    }
    if unreadable > 0 {
        ExitCode::from(2)
    } else if diverged > 0 {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// One corpus's totals for `cabal datc --json`. A case is skipped when the
/// harness evaluated no assertion for it at all; orders the corpus gives no
/// expectation for are counted apart, as `orders_without_expectation`.
fn corpus_json(name: &str, report: &datc_harness::Report) -> serde_json::Value {
    let skipped = report.cases.iter().filter(|c| c.checks == 0).count();
    serde_json::json!({
        "name": name,
        "total": report.cases.len(),
        "passed": report.passed() - report.cases.iter().filter(|c| c.checks == 0 && c.failures.is_empty()).count(),
        "failed": report.failed(),
        "skipped": skipped,
        "checks": report.checks(),
        "orders_without_expectation": report.skipped(),
        "failures": report
            .cases
            .iter()
            .filter(|c| !c.failures.is_empty())
            .map(|c| serde_json::json!({ "case": c.name, "failures": c.failures }))
            .collect::<Vec<_>>(),
    })
}

/// Adjudicate the DATC corpus and Cabal's supplementary cases, and report.
///
/// Prints pass, fail and skip totals and every failure; `--report` adds the
/// per-section table and `--json` prints one JSON document instead (the
/// phase 1 metric, issue #57). Exit status 1 when any case fails or is
/// skipped (adjudicated with no assertion evaluated).
fn datc(args: &[String]) -> ExitCode {
    const USAGE: &str = "usage: cabal datc [--report] [--json]";
    let sections = args.iter().any(|a| a == "--report");
    let json = args.iter().any(|a| a == "--json");
    if let Some(unknown) = args
        .iter()
        .find(|a| a.as_str() != "--report" && a.as_str() != "--json")
    {
        eprintln!("unknown option {unknown}\n{USAGE}");
        return ExitCode::from(2);
    }
    let datc = datc_harness::run_corpus(datc_harness::DATC_V3);
    let cabal = datc_harness::run_corpus(datc_harness::CABAL_CASES);
    let corpora = [
        corpus_json("DATC v3.0", &datc),
        corpus_json("Cabal cases", &cabal),
    ];
    let sum = |key: &str| {
        corpora
            .iter()
            .map(|c| c[key].as_u64().unwrap_or(0))
            .sum::<u64>()
    };
    let (failed, skipped) = (sum("failed"), sum("skipped"));
    if json {
        let all = serde_json::json!({
            "engine": VERSION,
            "total": sum("total"),
            "passed": sum("passed"),
            "failed": failed,
            "skipped": skipped,
            "corpora": corpora,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&all).expect("report serialises")
        );
    } else {
        print!("{}", datc_harness::render("DATC v3.0", &datc, sections));
        print!("{}", datc_harness::render("Cabal cases", &cabal, sections));
        // "Skipped" means the same here as in the JSON and the exit status: cases adjudicated
        // with no assertion evaluated. Orders a case gives no expectation for are counted apart.
        println!(
            "total: {} passed, {} failed, {} skipped; {} orders without an expectation",
            datc.passed() + cabal.passed(),
            failed,
            skipped,
            datc.skipped() + cabal.skipped()
        );
    }
    if failed == 0 && skipped == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
