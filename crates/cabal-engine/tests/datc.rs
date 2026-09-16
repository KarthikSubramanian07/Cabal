//! Runs the Diplomacy Adjudicator Test Cases v3.0 corpus in `tests/data/datc_v3.json`.
//!
//! Every case is a separate assertion; the suite fails if any case fails and
//! prints a per-section report so regressions are easy to locate.

use std::collections::{BTreeMap, HashMap};

use indexmap::IndexMap;

use cabal_engine::adjudicate::adjustment::resolve_adjustment;
use cabal_engine::adjudicate::movement::resolve_movement;
use cabal_engine::adjudicate::retreat::resolve_retreat;
use cabal_engine::geo::{Map, UnitKind};
use cabal_engine::order::{AdjustOrder, Order, RetreatOrder, Unit};
use cabal_engine::parse::{Parsed, parse};
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::{GameState, Phase, PhaseKind, Position, Season};
use serde::Deserialize;

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}

#[derive(Deserialize, Clone)]
struct Case {
    name: String,
    phase: String,
    #[serde(default)]
    edition: Option<String>,
    #[serde(default)]
    starting_state: Vec<String>,
    #[serde(default)]
    orders: IndexMap<String, Option<String>>,
    #[serde(default)]
    preceding_main_phase: Option<Preceding>,
    #[serde(default)]
    occupiers: BTreeMap<String, String>,
    #[serde(default)]
    civil_disorder: Vec<String>,
}

#[derive(Deserialize, Clone)]
struct Preceding {
    #[serde(default)]
    starting_state: Vec<String>,
    orders: IndexMap<String, Option<String>>,
}

fn corpus() -> Corpus {
    serde_json::from_str(include_str!("data/datc_v3.json")).expect("corpus parses")
}

/// `ENG: F lon` -> unit
fn unit_from_text(map: &Map, s: &str) -> Unit {
    let (power, rest) = s.split_once(':').expect("power prefix");
    let power = map.find_power(power.trim()).expect("power");
    let mut parts = rest.split_whitespace();
    let kind = match parts.next().expect("kind") {
        "A" => UnitKind::Army,
        "F" => UnitKind::Fleet,
        k => panic!("bad kind {k}"),
    };
    let region = map
        .parse_region(parts.next().expect("region"))
        .expect("region");
    Unit {
        power,
        kind,
        region,
    }
}

/// Build a position from explicit units plus units implied by the ordered units.
fn position_from(
    map: &Map,
    starting: &[String],
    orders: &IndexMap<String, Option<String>>,
) -> (Position, Vec<(String, Parsed)>) {
    let mut pos = Position::default();
    for s in starting {
        pos.add_unit(unit_from_text(map, s));
    }
    let mut parsed = Vec::new();
    for text in orders.keys() {
        match parse(map, text) {
            Ok(p) => {
                if let (Some(power), Some(kind), Some(region)) = (p.power, p.kind, p.region) {
                    // a unit implied by an order: the order text names the unit's real region
                    // (wrong coasts in order text are exercised by cases with an explicit starting state)
                    let region = if kind == UnitKind::Army {
                        cabal_engine::geo::Region::land(region.province)
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
                }
                parsed.push((text.clone(), p));
            }
            Err(e) => panic!("cannot parse {text}: {e}"),
        }
    }
    (pos, parsed)
}

fn rulebook(edition: &Option<String>) -> Rulebook {
    match edition {
        Some(e) => Rulebook::by_name(e).unwrap_or_else(|| panic!("unknown edition {e}")),
        None => Rulebook::default(),
    }
}

/// Run a main phase, checking expectations. Returns the resulting game state for retreat cases.
fn run_main(
    map: &Map,
    rb: Rulebook,
    starting: &[String],
    orders: &IndexMap<String, Option<String>>,
    failures: &mut Vec<String>,
) -> GameState {
    let (pos, parsed) = position_from(map, starting, orders);
    let typed: Vec<Order> = parsed
        .iter()
        .map(|(t, p)| p.to_movement(None).unwrap_or_else(|e| panic!("{t}: {e}")))
        .collect();
    let result = resolve_movement(map, &pos, rb, &typed);
    if std::env::var_os("CABAL_DEBUG").is_some() {
        for (o, out) in result.orders.iter().zip(&result.outcomes) {
            eprintln!(
                "    {} => {:?}",
                cabal_engine::text::order_text(map, &pos, o),
                out
            );
        }
    }
    for ((text, p), order) in parsed.iter().zip(&typed) {
        let Some(expect) = orders.get(text).cloned().flatten() else {
            continue;
        };
        let _ = p;
        let outcome = result
            .outcome_at(order.unit)
            .expect("outcome for ordered unit");
        let got = if outcome.succeeds() {
            "Succeeds"
        } else {
            "Fails"
        };
        if got != expect {
            failures.push(format!(
                "{text}: expected {expect}, got {got} ({outcome:?})"
            ));
        }
    }
    let mut state = GameState::from_position(
        Phase::new(1901, Season::Spring, PhaseKind::Retreat),
        result.position,
    );
    state.dislodged = result.dislodged;
    state.standoffs = result.standoffs;
    state
}

fn run_case(map: &Map, case: &Case) -> Vec<String> {
    let mut failures = Vec::new();
    let rb = rulebook(&case.edition);
    match case.phase.as_str() {
        "Main" => {
            run_main(map, rb, &case.starting_state, &case.orders, &mut failures);
        }
        "Retreat" => {
            let pre = case.preceding_main_phase.as_ref().expect("preceding phase");
            let state = run_main(map, rb, &pre.starting_state, &pre.orders, &mut failures);
            let mut typed: Vec<(String, RetreatOrder)> = Vec::new();
            for (text, expect) in &case.orders {
                let p = parse(map, text).unwrap_or_else(|e| panic!("{text}: {e}"));
                match p.to_retreat(None) {
                    Ok(o) => typed.push((text.clone(), o)),
                    Err(_) => {
                        // supports and convoys are illegal in the retreat phase: ignored
                        if expect.as_deref() == Some("Succeeds") {
                            failures.push(format!(
                                "{text}: expected Succeeds but the order is illegal in this phase"
                            ));
                        }
                    }
                }
            }
            let orders: Vec<RetreatOrder> = typed.iter().map(|(_, o)| *o).collect();
            let result = resolve_retreat(map, &state, &orders);
            for (text, o) in &typed {
                let Some(expect) = case.orders.get(text).cloned().flatten() else {
                    continue;
                };
                let outcome = result.outcome_at(o.unit).expect("retreat outcome");
                let got = if matches!(outcome, cabal_engine::outcome::RetreatOutcome::Succeeds) {
                    "Succeeds"
                } else {
                    "Fails"
                };
                if got != expect {
                    failures.push(format!(
                        "{text}: expected {expect}, got {got} ({outcome:?})"
                    ));
                }
            }
        }
        "Build" => {
            let mut pos = Position::default();
            for s in &case.starting_state {
                pos.add_unit(unit_from_text(map, s));
            }
            for (prov, power) in &case.occupiers {
                pos.owners.insert(
                    map.find_province(prov).expect("province"),
                    map.find_power(power).expect("power"),
                );
            }
            // a unit standing on a supply centre owns it (Fall ownership rule)
            for u in pos.units.clone() {
                if map.province(u.province()).supply_center != cabal_engine::geo::SupplyCenter::None
                {
                    pos.owners.insert(u.province(), u.power);
                }
            }
            let mut typed: Vec<(String, AdjustOrder)> = Vec::new();
            for text in case.orders.keys() {
                let p = parse(map, text).unwrap_or_else(|e| panic!("{text}: {e}"));
                typed.push((
                    text.clone(),
                    p.to_adjustment(None)
                        .unwrap_or_else(|e| panic!("{text}: {e}")),
                ));
            }
            let orders: Vec<AdjustOrder> = typed.iter().map(|(_, o)| *o).collect();
            let result = resolve_adjustment(map, &pos, rb, &orders);
            for (i, (text, _)) in typed.iter().enumerate() {
                let Some(expect) = case.orders.get(text).cloned().flatten() else {
                    continue;
                };
                let outcome = &result.outcomes[i];
                let got = if matches!(outcome, cabal_engine::outcome::AdjustOutcome::Succeeds) {
                    "Succeeds"
                } else {
                    "Fails"
                };
                if got != expect {
                    failures.push(format!(
                        "{text}: expected {expect}, got {got} ({outcome:?})"
                    ));
                }
            }
            for s in &case.civil_disorder {
                let u = unit_from_text(map, s);
                if !result
                    .civil_disorder
                    .iter()
                    .any(|d| d.province() == u.province())
                {
                    failures.push(format!(
                        "{s} should have been removed in civil disorder, removed: {:?}",
                        result.civil_disorder
                    ));
                }
            }
        }
        other => panic!("unknown phase {other}"),
    }
    failures
}

#[test]
fn datc_v3_corpus() {
    let map = Map::standard();
    let corpus = corpus();
    let mut by_section: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut failed: Vec<(String, Vec<String>)> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for case in &corpus.cases {
        let section = case.name.get(2..3).unwrap_or("?").to_ascii_uppercase();
        let entry = by_section.entry(section).or_insert((0, 0));
        entry.1 += 1;
        *seen.entry(case.name.clone()).or_default() += 1;
        let failures = run_case(map, case);
        if failures.is_empty() {
            entry.0 += 1;
        } else {
            failed.push((case.name.clone(), failures));
        }
    }
    println!("DATC v3.0 report");
    for (section, (pass, total)) in &by_section {
        println!("  6.{section}: {pass}/{total}");
    }
    for (name, failures) in &failed {
        println!("FAIL {name}");
        for f in failures {
            println!("    {f}");
        }
    }
    let total: usize = by_section.values().map(|(_, t)| t).sum();
    let passed: usize = by_section.values().map(|(p, _)| p).sum();
    println!("  total: {passed}/{total}");
    assert!(failed.is_empty(), "{} DATC cases failed", failed.len());
}
