//! The DATC conformance harness, shared by `tests/datc.rs` and `cabal datc`.
//!
//! A case names orders and, for each, whether DATC expects it to succeed. That
//! was all the harness used to check, which let a wrong standoff list through:
//! nothing looked at dislodgements, standoffs or the resulting position. It now
//! checks, for every case:
//!
//! - each order's stated expectation (`Succeeds` / `Fails`);
//! - the dislodgements the expectations imply: a unit is dislodged exactly when
//!   a move into its province is expected to succeed and it does not itself
//!   leave, and never when every move into its province is expected to fail;
//! - that the engine's dislodged list, attacker origins, standoff list and
//!   resulting position agree with its own outcomes, so a bounce in a vacant
//!   province is always a standoff and nothing moves that did not succeed;
//! - in retreat cases, that a retreat expected to succeed is offered by
//!   `legal_retreats` and lands, and one expected to fail does not;
//! - explicit `dislodged`, `standoffs` and `retreats` lists where a case has
//!   them (the DATC layout has none; Cabal's supplementary cases do).
//!
//! An order whose expectation is `null` in the corpus is counted as skipped.
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};

use cabal_engine::adjudicate::adjustment::resolve_adjustment;
use cabal_engine::adjudicate::movement::{
    MovementResult, resolve_movement, resolve_movement_with_dependencies,
};
use cabal_engine::adjudicate::retreat::resolve_retreat;
use cabal_engine::geo::{Map, ProvinceId, UnitKind};
use cabal_engine::legal::legal_retreats;
use cabal_engine::order::{AdjustOrder, Command, Order, RetreatCommand, RetreatOrder, Unit};
use cabal_engine::outcome::{MoveOutcome, OrderOutcome, RetreatOutcome};
use cabal_engine::parse::{Parsed, parse};
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::{GameState, Phase, PhaseKind, Position, Season};
use indexmap::IndexMap;
use serde::Deserialize;

/// DATC v3.0 in the JSON layout of TedDriggs/diplomacy.
pub const DATC_V3: &str = include_str!("../data/datc_v3.json");
/// Cabal's own cases, same layout plus explicit dislodgement and standoff lists.
pub const CABAL_CASES: &str = include_str!("../data/cabal_cases.json");

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
    #[serde(flatten)]
    expect: Explicit,
}

#[derive(Deserialize, Clone)]
struct Preceding {
    #[serde(default)]
    starting_state: Vec<String>,
    orders: IndexMap<String, Option<String>>,
    #[serde(flatten)]
    expect: Explicit,
}

/// Exact expectations a case may state about its main phase.
#[derive(Deserialize, Clone, Default)]
struct Explicit {
    /// Every dislodged unit with its attacker's origin: `GER: A mun <- bur`.
    #[serde(default)]
    dislodged: Option<Vec<String>>,
    /// Every standoff province.
    #[serde(default)]
    standoffs: Option<Vec<String>>,
    /// Legal retreat destinations of a dislodged unit, by its province.
    #[serde(default)]
    retreats: Option<BTreeMap<String, Vec<String>>>,
}

/// The outcome of one case.
pub struct CaseReport {
    pub name: String,
    /// DATC section letter (`A` for 6.A), or `X` for Cabal's own cases.
    pub section: String,
    /// Assertions evaluated.
    pub checks: usize,
    /// Orders the corpus gives no expectation for.
    pub skipped: usize,
    pub failures: Vec<String>,
}

pub struct Report {
    pub cases: Vec<CaseReport>,
}

impl Report {
    pub fn passed(&self) -> usize {
        self.cases.iter().filter(|c| c.failures.is_empty()).count()
    }

    pub fn failed(&self) -> usize {
        self.cases.len() - self.passed()
    }

    pub fn checks(&self) -> usize {
        self.cases.iter().map(|c| c.checks).sum()
    }

    pub fn skipped(&self) -> usize {
        self.cases.iter().map(|c| c.skipped).sum()
    }

    /// `(passed, total)` per section, in section order.
    pub fn by_section(&self) -> BTreeMap<String, (usize, usize)> {
        let mut out: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        for c in &self.cases {
            let entry = out.entry(c.section.clone()).or_default();
            entry.1 += 1;
            if c.failures.is_empty() {
                entry.0 += 1;
            }
        }
        out
    }
}

/// Counts assertions and collects the ones that fail.
#[derive(Default)]
struct Tally {
    checks: usize,
    skipped: usize,
    failures: Vec<String>,
}

impl Tally {
    fn check(&mut self, ok: bool, message: impl FnOnce() -> String) {
        self.checks += 1;
        if !ok {
            self.failures.push(message());
        }
    }
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

fn code(map: &Map, p: ProvinceId) -> String {
    map.province(p).name.to_ascii_uppercase()
}

/// The engine's lists must follow from its own outcomes. This is what catches
/// a ruling that says "bounced" in the outcome and forgets the standoff.
pub fn check_movement_invariants(
    map: &Map,
    before: &Position,
    result: &MovementResult,
) -> Vec<String> {
    let mut problems = Vec::new();
    let moved: BTreeMap<ProvinceId, ProvinceId> = result
        .orders
        .iter()
        .zip(&result.outcomes)
        .filter_map(|(o, out)| match (o.command, out) {
            (Command::Move { dest, .. }, OrderOutcome::Move(MoveOutcome::Succeeds)) => {
                Some((o.unit, dest))
            }
            _ => None,
        })
        .collect();
    let arrivals: BTreeMap<ProvinceId, ProvinceId> = moved.iter().map(|(&f, &t)| (t, f)).collect();
    if arrivals.len() != moved.len() {
        problems.push("two units moved into the same province".to_string());
    }

    // dislodged: exactly the units that stayed where another unit arrived
    let expected: BTreeMap<ProvinceId, ProvinceId> = before
        .units
        .iter()
        .map(|u| u.province())
        .filter(|p| !moved.contains_key(p))
        .filter_map(|p| arrivals.get(&p).map(|&from| (p, from)))
        .collect();
    let listed: BTreeMap<ProvinceId, ProvinceId> = result
        .dislodged
        .iter()
        .map(|d| (d.unit.province(), d.attacker_from))
        .collect();
    if expected != listed {
        let show = |m: &BTreeMap<ProvinceId, ProvinceId>| {
            m.iter()
                .map(|(&p, &from)| format!("{} from {}", code(map, p), code(map, from)))
                .collect::<Vec<_>>()
                .join(", ")
        };
        problems.push(format!(
            "dislodged list [{}] does not follow from the outcomes [{}]",
            show(&listed),
            show(&expected)
        ));
    }

    // position: every unit is where its outcome puts it
    for u in &before.units {
        let p = u.province();
        let now = match moved.get(&p) {
            Some(&dest) => Some(dest),
            None if expected.contains_key(&p) => None,
            None => Some(p),
        };
        let found = now.and_then(|at| result.position.unit_at(at));
        let ok = match now {
            Some(_) => found.is_some_and(|f| f.power == u.power && f.kind == u.kind),
            None => !result
                .position
                .units
                .iter()
                .any(|f| f.province() == p && f.power == u.power),
        };
        if !ok {
            problems.push(format!(
                "the unit from {} is not where its outcome puts it",
                code(map, p)
            ));
        }
    }
    let survivors = before.units.len() - expected.len();
    if result.position.units.len() != survivors {
        problems.push(format!(
            "{} units after the phase, expected {survivors}",
            result.position.units.len()
        ));
    }

    // standoffs: a vacant province where two or more units bounced off each other
    let mut bounced: BTreeMap<ProvinceId, usize> = BTreeMap::new();
    let mut failed_into: BTreeSet<ProvinceId> = BTreeSet::new();
    for (o, out) in result.orders.iter().zip(&result.outcomes) {
        if let (Command::Move { dest, .. }, OrderOutcome::Move(m)) = (o.command, out) {
            if *m != MoveOutcome::Succeeds {
                failed_into.insert(dest);
            }
            if matches!(m, MoveOutcome::Bounced { .. }) {
                *bounced.entry(dest).or_default() += 1;
            }
        }
    }
    for (&p, &n) in &bounced {
        let vacant = result.position.unit_at(p).is_none();
        if n >= 2 && vacant && !result.standoffs.contains(&p) {
            problems.push(format!(
                "{n} units bounced in vacant {} but it is not a standoff",
                code(map, p)
            ));
        }
    }
    for &p in &result.standoffs {
        if result.position.unit_at(p).is_some() {
            problems.push(format!("standoff province {} is occupied", code(map, p)));
        }
        if !failed_into.contains(&p) {
            problems.push(format!(
                "standoff province {} had no failed move into it",
                code(map, p)
            ));
        }
    }
    problems
}

/// Run a main phase, checking expectations. Returns the resulting game state for retreat cases.
fn run_main(
    map: &Map,
    rb: Rulebook,
    starting: &[String],
    orders: &IndexMap<String, Option<String>>,
    explicit: &Explicit,
    tally: &mut Tally,
) -> GameState {
    let (pos, parsed) = position_from(map, starting, orders);
    let typed: Vec<Order> = parsed
        .iter()
        .map(|(t, p)| p.to_movement(None).unwrap_or_else(|e| panic!("{t}: {e}")))
        .collect();
    let result = resolve_movement(map, &pos, rb, &typed);
    let (traced, dependencies) = resolve_movement_with_dependencies(map, &pos, rb, &typed);
    tally.check(traced == result, || {
        "dependency tracing changed the adjudication".to_string()
    });
    let mut reversed = typed.clone();
    reversed.reverse();
    let mut reversed_position = pos.clone();
    reversed_position.units.reverse();
    let (repeated, repeated_dependencies) =
        resolve_movement_with_dependencies(map, &reversed_position, rb, &reversed);
    tally.check(
        repeated == traced
            && repeated_dependencies == dependencies
            && dependencies.to_dot(map, &pos)
                == repeated_dependencies.to_dot(map, &reversed_position),
        || "the result depends on the order of orders or units".to_string(),
    );
    if std::env::var_os("CABAL_DEBUG").is_some() {
        for (o, out) in result.orders.iter().zip(&result.outcomes) {
            eprintln!(
                "    {} => {:?}",
                cabal_engine::text::order_text(map, &pos, o),
                out
            );
        }
    }

    // 1. the stated expectation of every order
    for ((text, _), order) in parsed.iter().zip(&typed) {
        let Some(expect) = orders.get(text).cloned().flatten() else {
            tally.skipped += 1;
            continue;
        };
        let outcome = result
            .outcome_at(order.unit)
            .expect("outcome for ordered unit");
        let got = if outcome.succeeds() {
            "Succeeds"
        } else {
            "Fails"
        };
        tally.check(got == expect, || {
            format!("{text}: expected {expect}, got {got} ({outcome:?})")
        });
    }

    // 2. the dislodgements those expectations imply
    let expectation = |i: usize| orders.get(&parsed[i].0).cloned().flatten();
    let is_dislodged = |p: ProvinceId| result.dislodged.iter().any(|d| d.unit.province() == p);
    for unit in &pos.units {
        let here = unit.province();
        let own: Vec<usize> = (0..typed.len())
            .filter(|&i| typed[i].unit == here && typed[i].power == unit.power)
            .collect();
        // does the corpus say this unit leaves, stays, or neither?
        let leaves = match own.as_slice() {
            [] => Some(false),
            [i] => match typed[*i].command {
                Command::Move { .. } => expectation(*i).map(|e| e == "Succeeds"),
                _ => Some(false),
            },
            _ => None, // several orders for one unit: the corpus is testing that
        };
        let incoming: Vec<usize> = (0..typed.len())
            .filter(|&i| matches!(typed[i].command, Command::Move { dest, .. } if dest == here))
            .collect();
        let arrives = incoming
            .iter()
            .find(|&&i| expectation(i).as_deref() == Some("Succeeds"));
        let none_arrive = incoming
            .iter()
            .all(|&i| expectation(i).as_deref() == Some("Fails"));
        let name = cabal_engine::text::unit_text(map, unit);
        match (leaves, arrives) {
            (Some(false), Some(&i)) => {
                let from = typed[i].unit;
                let listed = result
                    .dislodged
                    .iter()
                    .find(|d| d.unit.province() == here)
                    .map(|d| d.attacker_from);
                tally.check(listed == Some(from), || {
                    format!(
                        "{name} should be dislodged from {} ({}), dislodged list says {:?}",
                        code(map, from),
                        parsed[i].0,
                        listed.map(|p| code(map, p))
                    )
                });
            }
            (Some(_), None) if none_arrive => {
                tally.check(!is_dislodged(here), || {
                    format!("{name} should not be dislodged: no move into its province succeeds")
                });
            }
            (Some(true), _) => {
                tally.check(!is_dislodged(here), || {
                    format!("{name} moves away and cannot be dislodged")
                });
            }
            _ => {}
        }
    }

    // 3. the engine's lists agree with its own outcomes
    let problems = check_movement_invariants(map, &pos, &result);
    tally.check(problems.is_empty(), || problems.join("; "));

    let mut state = GameState::from_position(
        Phase::new(1901, Season::Spring, PhaseKind::Retreat),
        result.position.clone(),
    );
    state.dislodged = result.dislodged.clone();
    state.standoffs = result.standoffs.clone();

    // 4. explicit lists, where the case has them
    if let Some(expected) = &explicit.dislodged {
        let want: BTreeSet<String> = expected
            .iter()
            .map(|line| {
                let (unit, from) = line.split_once("<-").expect("`UNIT <- origin`");
                let unit = unit_from_text(map, unit.trim());
                let from = map.find_province(from.trim()).expect("origin");
                format!("{} <- {}", code(map, unit.province()), code(map, from))
            })
            .collect();
        let have: BTreeSet<String> = result
            .dislodged
            .iter()
            .map(|d| {
                format!(
                    "{} <- {}",
                    code(map, d.unit.province()),
                    code(map, d.attacker_from)
                )
            })
            .collect();
        tally.check(want == have, || {
            format!("dislodged: expected {want:?}, got {have:?}")
        });
    }
    if let Some(expected) = &explicit.standoffs {
        let want: BTreeSet<String> = expected
            .iter()
            .map(|p| code(map, map.find_province(p).expect("province")))
            .collect();
        let have: BTreeSet<String> = result.standoffs.iter().map(|&p| code(map, p)).collect();
        tally.check(want == have, || {
            format!("standoffs: expected {want:?}, got {have:?}")
        });
    }
    if let Some(expected) = &explicit.retreats {
        for (unit, dests) in expected {
            let here = map.find_province(unit).expect("province");
            let power = state
                .dislodged
                .iter()
                .find(|d| d.unit.province() == here)
                .map(|d| d.unit.power);
            let want: BTreeSet<String> = dests
                .iter()
                .map(|p| code(map, map.find_province(p).expect("province")))
                .collect();
            let have: Option<BTreeSet<String>> = power.map(|power| {
                legal_retreats(map, &state, power)
                    .remove(&here)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|o| match o.command {
                        RetreatCommand::Retreat { dest, .. } => Some(code(map, dest)),
                        RetreatCommand::Disband => None,
                    })
                    .collect()
            });
            tally.check(have.as_ref() == Some(&want), || {
                format!(
                    "retreats of {}: expected {want:?}, got {have:?}",
                    unit.to_ascii_uppercase()
                )
            });
        }
    }
    state
}

fn run_case(map: &Map, case: &Case) -> Tally {
    let mut tally = Tally::default();
    let rb = rulebook(&case.edition);
    match case.phase.as_str() {
        "Main" => {
            run_main(
                map,
                rb,
                &case.starting_state,
                &case.orders,
                &case.expect,
                &mut tally,
            );
        }
        "Retreat" => {
            let pre = case.preceding_main_phase.as_ref().expect("preceding phase");
            let state = run_main(
                map,
                rb,
                &pre.starting_state,
                &pre.orders,
                &pre.expect,
                &mut tally,
            );
            let mut typed: Vec<(String, RetreatOrder)> = Vec::new();
            for (text, expect) in &case.orders {
                let p = parse(map, text).unwrap_or_else(|e| panic!("{text}: {e}"));
                match p.to_retreat(None) {
                    Ok(o) => typed.push((text.clone(), o)),
                    Err(_) => {
                        // supports and convoys are illegal in the retreat phase: ignored
                        match expect.as_deref() {
                            None => tally.skipped += 1,
                            Some(e) => tally.check(e != "Succeeds", || {
                                format!(
                                    "{text}: expected Succeeds but the order is illegal in this phase"
                                )
                            }),
                        }
                    }
                }
            }
            let orders: Vec<RetreatOrder> = typed.iter().map(|(_, o)| *o).collect();
            let result = resolve_retreat(map, &state, &orders);
            for (text, o) in &typed {
                let outcome = result.outcome_at(o.unit).expect("retreat outcome");
                let succeeded = matches!(outcome, RetreatOutcome::Succeeds);
                // the legal list and the resolver must agree on what is illegal
                if let RetreatCommand::Retreat { dest, .. } = o.command {
                    let offered = legal_retreats(map, &state, o.power)
                        .get(&o.unit)
                        .is_some_and(|l| {
                            l.iter().any(|x| {
                                matches!(x.command, RetreatCommand::Retreat { dest: d, .. } if d == dest)
                            })
                        });
                    let illegal = matches!(outcome, RetreatOutcome::Illegal { .. });
                    tally.check(offered != illegal, || {
                        format!(
                            "{text}: legal_retreats {} it but the resolver judged it {outcome:?}",
                            if offered { "offers" } else { "does not offer" }
                        )
                    });
                    let arrived = result
                        .position
                        .unit_at(dest)
                        .is_some_and(|u| u.power == o.power);
                    tally.check(arrived == succeeded, || {
                        format!(
                            "{text}: outcome {outcome:?} but the unit {} at its destination",
                            if arrived { "is" } else { "is not" }
                        )
                    });
                }
                let Some(expect) = case.orders.get(text).cloned().flatten() else {
                    tally.skipped += 1;
                    continue;
                };
                let got = if succeeded { "Succeeds" } else { "Fails" };
                tally.check(got == expect, || {
                    format!("{text}: expected {expect}, got {got} ({outcome:?})")
                });
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
                    tally.skipped += 1;
                    continue;
                };
                let outcome = &result.outcomes[i];
                let got = if matches!(outcome, cabal_engine::outcome::AdjustOutcome::Succeeds) {
                    "Succeeds"
                } else {
                    "Fails"
                };
                tally.check(got == expect, || {
                    format!("{text}: expected {expect}, got {got} ({outcome:?})")
                });
            }
            for s in &case.civil_disorder {
                let u = unit_from_text(map, s);
                let removed = result
                    .civil_disorder
                    .iter()
                    .any(|d| d.province() == u.province());
                tally.check(removed, || {
                    format!(
                        "{s} should have been removed in civil disorder, removed: {:?}",
                        result.civil_disorder
                    )
                });
                tally.check(result.position.unit_at(u.province()).is_none(), || {
                    format!("{s} was removed in civil disorder but is still on the board")
                });
            }
        }
        other => panic!("unknown phase {other}"),
    }
    tally
}

/// Run every case of a corpus in the DATC JSON layout.
pub fn run_corpus(json: &str) -> Report {
    let map = Map::standard();
    let corpus: Corpus = serde_json::from_str(json).expect("corpus parses");
    let cases = corpus
        .cases
        .iter()
        .map(|case| {
            let tally = run_case(map, case);
            // DATC names look like `t6a01_...`; anything else is one of ours
            let section = match case.name.strip_prefix("t6") {
                Some(rest) => rest.get(0..1).unwrap_or("?").to_ascii_uppercase(),
                None => "X".to_string(),
            };
            CaseReport {
                name: case.name.clone(),
                section,
                checks: tally.checks,
                skipped: tally.skipped,
                failures: tally.failures,
            }
        })
        .collect();
    Report { cases }
}

/// The report as text: totals, every failure, and optionally the section table.
pub fn render(title: &str, report: &Report, sections: bool) -> String {
    let mut out = format!(
        "{title}: {} cases, {} passed, {} failed; {} checks, {} orders skipped (no expectation in the corpus)\n",
        report.cases.len(),
        report.passed(),
        report.failed(),
        report.checks(),
        report.skipped()
    );
    if sections {
        for (section, (pass, total)) in report.by_section() {
            let label = if section == "X" {
                "cabal".to_string()
            } else {
                format!("6.{section}")
            };
            out += &format!("  {label}: {pass}/{total}\n");
        }
    }
    for case in report.cases.iter().filter(|c| !c.failures.is_empty()) {
        out += &format!("FAIL {}\n", case.name);
        for f in &case.failures {
            out += &format!("    {f}\n");
        }
    }
    out
}
