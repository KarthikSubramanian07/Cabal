//! `cabal arena`: bot against bot, natively, on every core.
//!
//! ```text
//! cabal arena [--games N] [--seed S] [--jobs J] [--max-year Y]
//!             [--levels hard,standard,easy] [--out DIR] [--no-games]
//!             [--check-strength] [--margin PERCENT]
//! ```
//!
//! Each game seats the seven powers with levels drawn from `--levels` (balanced:
//! within every block of games each power plays each level equally often), plays
//! to a solo or to the end of `--max-year` (then a draw among the survivors),
//! and is written to `DIR/games/<id>.json` as a MILA saved game that
//! `cabal replay` re-adjudicates. `DIR/summary.json` and `DIR/summary.md` hold
//! the aggregate: throughput, results, per-power and per-level tables, and a
//! level-against-level strength table.
//!
//! The exit code is non-zero when any order was judged illegal, any decision was
//! incomplete, the validator had to refuse anything the planner proposed, a power
//! contradicted its own orders (a support or convoy adjudicated void, for one),
//! any saved game failed to replay to the same position, or (with
//! `--check-strength`) a stronger level failed to beat a weaker one by the margin.
//! Everything except the timing fields is a pure function of the arguments.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use cabal_bot::{Level, contradictions, decide};
use cabal_engine::adjudicate::adjustment::allowance;
use cabal_engine::geo::{Map, Power};
use cabal_engine::json::SavedGame;
use cabal_engine::order::{AnyOrder, Order};
use cabal_engine::outcome::{
    AdjustOutcome, ConvoyOutcome, OrderOutcome, RetreatOutcome, SupportOutcome,
};
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::PhaseKind;
use cabal_engine::{Game, PhaseResult, Status};
use rayon::prelude::*;
use serde::Serialize;

#[derive(Clone, Debug)]
pub struct Config {
    pub games: u64,
    pub seed: u64,
    pub jobs: usize,
    pub max_year: u16,
    pub levels: Vec<Level>,
    pub out: PathBuf,
    pub save_games: bool,
    pub check_strength: bool,
    /// How far above an even 50 percent a stronger level must score against a weaker one.
    pub margin: f64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            games: 100,
            seed: 1,
            jobs: 0,
            max_year: 1910,
            levels: vec![Level::Hard, Level::Standard, Level::Easy],
            out: PathBuf::from("target/arena"),
            save_games: true,
            check_strength: false,
            margin: 5.0,
        }
    }
}

const USAGE: &str = "usage: cabal arena [--games N] [--seed S] [--jobs J] [--max-year Y] \
[--levels hard,standard,easy] [--out DIR] [--no-games] [--check-strength] [--margin PERCENT]";

pub fn parse_args(args: &[String]) -> Result<Config, String> {
    let mut c = Config::default();
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match flag.as_str() {
            "--games" => c.games = number(&value("--games")?, "--games")?,
            "--seed" => c.seed = number(&value("--seed")?, "--seed")?,
            "--jobs" => c.jobs = number(&value("--jobs")?, "--jobs")?,
            "--max-year" => c.max_year = number(&value("--max-year")?, "--max-year")?,
            "--margin" => c.margin = number(&value("--margin")?, "--margin")?,
            "--out" => c.out = PathBuf::from(value("--out")?),
            "--levels" => {
                c.levels = value("--levels")?
                    .split(',')
                    .map(|s| Level::parse(s).ok_or_else(|| format!("unknown level {s}")))
                    .collect::<Result<_, _>>()?;
            }
            "--no-games" => c.save_games = false,
            "--check-strength" => c.check_strength = true,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if c.levels.is_empty() || c.levels.len() > 7 {
        return Err("--levels takes one to seven levels".into());
    }
    if c.max_year < 1901 {
        return Err("--max-year must be 1901 or later".into());
    }
    Ok(c)
}

fn number<T: std::str::FromStr>(s: &str, name: &str) -> Result<T, String> {
    s.parse()
        .map_err(|_| format!("{name}: cannot read {s} as a number"))
}

pub fn run(args: &[String]) -> ExitCode {
    let config = match parse_args(args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let summary = match play_all(&config) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("arena failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    let text = summary.to_markdown();
    let written = std::fs::create_dir_all(&config.out)
        .and_then(|()| {
            let json = serde_json::to_string_pretty(&summary).expect("summary serialises");
            std::fs::write(config.out.join("summary.json"), json + "\n")
        })
        .and_then(|()| std::fs::write(config.out.join("summary.md"), &text));
    if let Err(e) = written {
        eprintln!("cannot write the summary to {}: {e}", config.out.display());
        return ExitCode::FAILURE;
    }
    print!("{text}");
    if summary.failures.is_empty() {
        ExitCode::SUCCESS
    } else {
        for f in &summary.failures {
            eprintln!("FAIL: {f}");
        }
        ExitCode::FAILURE
    }
}

// ---------- one game ----------

/// What one finished game looked like.
#[derive(Clone, Debug, Serialize)]
pub struct GameReport {
    pub id: String,
    pub seed: u64,
    /// Level per power, in map order.
    pub levels: Vec<&'static str>,
    pub phases: usize,
    pub final_year: u16,
    /// Three letter code of the solo winner, if there was one.
    pub solo: Option<String>,
    /// Powers still holding a centre at the end.
    pub survivors: usize,
    /// Final centres per power, in map order.
    pub centres: Vec<usize>,
    pub orders: u64,
    pub illegal: u64,
    pub incomplete: u64,
    /// Orders the bot's planner proposed and the validator refused (then held).
    pub rejected: u64,
    /// Orders that contradict another order of the same power.
    pub contradictions: u64,
    /// Support orders given, and how many the adjudicator found void.
    pub supports: u64,
    pub void_supports: u64,
    /// Convoy orders given, and how many the adjudicator found void.
    pub convoys: u64,
    pub void_convoys: u64,
    pub replay_ok: bool,
    #[serde(skip)]
    seat_levels: Vec<Level>,
    /// Per level: (decisions, nanoseconds, slowest nanoseconds).
    #[serde(skip)]
    think: BTreeMap<Level, (u64, u128, u128)>,
}

/// SplitMix64, to derive per-game seeds and seatings from the arena seed.
fn mix(a: u64, b: u64) -> u64 {
    let mut z = a
        .wrapping_add(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(b.wrapping_mul(0xD6E8_FEB8_6659_FD93));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Levels per power for game `index`. Games come in blocks as long as the level
/// list; inside a block a fixed random seating is rotated, so every power plays
/// every level once per block.
pub fn seating(config: &Config, index: u64, powers: usize) -> Vec<Level> {
    let n = config.levels.len() as u64;
    let block = index / n;
    let mut order: Vec<usize> = (0..powers).collect();
    let mut state = mix(config.seed, block);
    for i in (1..powers).rev() {
        state = mix(state, i as u64);
        order.swap(i, (state % (i as u64 + 1)) as usize);
    }
    let mut out = vec![config.levels[0]; powers];
    for (slot, &power) in order.iter().enumerate() {
        out[power] = config.levels[((slot as u64 + index) % n) as usize];
    }
    out
}

pub fn play_game(config: &Config, index: u64) -> Result<GameReport, String> {
    let map = Map::standard();
    let seed = mix(config.seed, index.wrapping_add(0x51ED));
    let levels = seating(config, index, map.powers().len());
    let mut game = Game::new(map, Rulebook::default());
    let mut think: BTreeMap<Level, (u64, u128, u128)> = BTreeMap::new();
    let (mut orders_seen, mut illegal, mut incomplete) = (0u64, 0u64, 0u64);
    let (mut rejected, mut contradicting) = (0u64, 0u64);
    let (mut supports, mut void_supports, mut convoys, mut void_convoys) = (0u64, 0u64, 0u64, 0u64);

    while game.status == Status::Active {
        if game.phase().year > config.max_year {
            game.declare_draw();
            break;
        }
        let kind = game.phase().kind;
        let mut orders = Vec::new();
        for p in map.power_ids() {
            let level = levels[p.0 as usize];
            let started = Instant::now();
            let decision = decide(map, game.rulebook, &game.state, p, seed, level);
            let spent = started.elapsed().as_nanos();
            let expected = match kind {
                PhaseKind::Movement => game.state.position.count_units(p),
                PhaseKind::Retreat => game
                    .state
                    .dislodged
                    .iter()
                    .filter(|d| d.unit.power == p)
                    .count(),
                PhaseKind::Adjustment => allowance(&game.state.position, p).unsigned_abs() as usize,
            };
            if expected > 0 {
                let slot = think.entry(level).or_default();
                slot.0 += 1;
                slot.1 += spent;
                slot.2 = slot.2.max(spent);
            }
            if decision.orders.len() != expected {
                incomplete += 1;
            }
            rejected += u64::from(decision.intent.rejected);
            if kind == PhaseKind::Movement {
                let mine: Vec<Order> = decision
                    .orders
                    .iter()
                    .filter_map(|o| match o {
                        AnyOrder::Movement(o) => Some(*o),
                        _ => None,
                    })
                    .collect();
                contradicting += contradictions(&mine) as u64;
            }
            orders.extend(decision.orders);
        }
        orders_seen += orders.len() as u64;
        let result = game.process(&orders).map_err(|e| e.to_string())?;
        illegal += match result {
            PhaseResult::Movement(r) => {
                for o in &r.outcomes {
                    match o {
                        OrderOutcome::Support(s) => {
                            supports += 1;
                            void_supports += u64::from(*s == SupportOutcome::Void);
                        }
                        OrderOutcome::Convoy(c) => {
                            convoys += 1;
                            void_convoys += u64::from(*c == ConvoyOutcome::Void);
                        }
                        _ => {}
                    }
                }
                r.outcomes
                    .iter()
                    .filter(|o| matches!(o, OrderOutcome::Illegal { .. }))
                    .count()
            }
            PhaseResult::Retreat(r) => r
                .outcomes
                .iter()
                .filter(|o| matches!(o, RetreatOutcome::Illegal { .. }))
                .count(),
            PhaseResult::Adjustment(r) => r
                .outcomes
                .iter()
                .filter(|o| matches!(o, AdjustOutcome::Illegal { .. }))
                .count(),
        } as u64;
    }

    let id = format!("arena-{}-{index:05}", config.seed);
    let saved = game.to_saved(&id);
    let json = serde_json::to_string(&saved).map_err(|e| e.to_string())?;
    let replay_ok = replays(&json, &game);
    if config.save_games {
        let dir = config.out.join("games");
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let path = dir.join(format!("{id}.json"));
        std::fs::write(&path, json + "\n").map_err(|e| format!("{}: {e}", path.display()))?;
    }

    let centres: Vec<usize> = map
        .power_ids()
        .map(|p| game.state.position.count_centers(p))
        .collect();
    Ok(GameReport {
        id,
        seed,
        levels: levels.iter().map(|l| l.name()).collect(),
        phases: game.history.len(),
        final_year: game.phase().year.min(config.max_year),
        solo: match game.status {
            Status::Solo { winner } => Some(map.power(winner).code.clone()),
            _ => None,
        },
        survivors: centres.iter().filter(|&&c| c > 0).count(),
        centres,
        orders: orders_seen,
        illegal,
        incomplete,
        rejected,
        contradictions: contradicting,
        supports,
        void_supports,
        convoys,
        void_convoys,
        replay_ok,
        seat_levels: levels,
        think,
    })
}

/// Does the saved text re-adjudicate, phase by phase, to the position the game ended in?
fn replays(json: &str, game: &Game) -> bool {
    let Ok(saved) = serde_json::from_str::<SavedGame>(json) else {
        return false;
    };
    match Game::from_saved(&saved, game.rulebook) {
        Ok(again) => {
            again.state.position == game.state.position && again.history.len() == game.history.len()
        }
        Err(_) => false,
    }
}

// ---------- the summary ----------

#[derive(Clone, Debug, Serialize)]
pub struct PowerRow {
    pub power: String,
    pub solos: u64,
    /// Share of the result: 1 for a solo, 1/n for each of n survivors of a draw.
    pub win_share: f64,
    pub mean_centres: f64,
    pub survival: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct LevelRow {
    pub level: &'static str,
    pub seats: u64,
    pub solos: u64,
    pub win_share: f64,
    pub mean_centres: f64,
    pub survival: f64,
    pub decisions: u64,
    /// Timing: machine dependent, not part of the deterministic output.
    pub mean_decision_us: f64,
    pub max_decision_us: f64,
}

/// Row level against column level, over every pair of seats in the same game.
#[derive(Clone, Debug, Serialize)]
pub struct Matchup {
    pub level: &'static str,
    pub against: &'static str,
    pub pairs: u64,
    /// Percent of pairs in which `level` finished with more centres (a tie counts half).
    pub ahead: f64,
    pub mean_centre_lead: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Summary {
    pub games: u64,
    pub seed: u64,
    pub max_year: u16,
    pub levels: Vec<&'static str>,
    pub jobs: usize,
    pub seconds: f64,
    pub games_per_second: f64,
    pub phases: u64,
    pub mean_phases: f64,
    pub mean_final_year: f64,
    pub solos: u64,
    pub solo_rate: f64,
    /// Number of games that ended in a draw of each size.
    pub draw_sizes: BTreeMap<usize, u64>,
    pub orders: u64,
    pub illegal_orders: u64,
    pub incomplete_decisions: u64,
    /// Orders the planner proposed and the engine's validator refused.
    pub rejected_orders: u64,
    /// Orders that contradicted another order of the same power.
    pub contradictions: u64,
    pub supports: u64,
    pub void_supports: u64,
    pub convoys: u64,
    pub void_convoys: u64,
    pub replay_divergences: u64,
    pub powers: Vec<PowerRow>,
    pub by_level: Vec<LevelRow>,
    pub matchups: Vec<Matchup>,
    pub failures: Vec<String>,
    #[serde(rename = "game_reports")]
    pub reports: Vec<GameReport>,
}

pub fn play_all(config: &Config) -> Result<Summary, String> {
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(config.jobs)
        .build()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    let reports: Vec<GameReport> = pool.install(|| {
        (0..config.games)
            .into_par_iter()
            .map(|i| play_game(config, i))
            .collect::<Result<_, _>>()
    })?;
    let seconds = started.elapsed().as_secs_f64();
    Ok(summarise(
        config,
        reports,
        seconds,
        pool.current_num_threads(),
    ))
}

pub fn summarise(config: &Config, reports: Vec<GameReport>, seconds: f64, jobs: usize) -> Summary {
    let map = Map::standard();
    let games = reports.len() as u64;
    let per = |x: f64, n: u64| if n == 0 { 0.0 } else { x / n as f64 };
    let mut levels: Vec<Level> = config.levels.clone();
    levels.sort_by_key(|l| std::cmp::Reverse(*l));
    levels.dedup();

    // share of the result per seat of one game
    let shares = |r: &GameReport| -> Vec<f64> {
        map.power_ids()
            .map(|p: Power| {
                let i = p.0 as usize;
                match &r.solo {
                    Some(code) => f64::from(u8::from(*code == map.power(p).code)),
                    None if r.centres[i] > 0 => 1.0 / r.survivors.max(1) as f64,
                    None => 0.0,
                }
            })
            .collect()
    };

    let powers = map
        .power_ids()
        .map(|p| {
            let i = p.0 as usize;
            let code = &map.power(p).code;
            PowerRow {
                power: code.clone(),
                solos: reports
                    .iter()
                    .filter(|r| r.solo.as_ref() == Some(code))
                    .count() as u64,
                win_share: per(reports.iter().map(|r| shares(r)[i]).sum(), games),
                mean_centres: per(reports.iter().map(|r| r.centres[i] as f64).sum(), games),
                survival: per(
                    reports.iter().filter(|r| r.centres[i] > 0).count() as f64,
                    games,
                ),
            }
        })
        .collect();

    let by_level = levels
        .iter()
        .map(|&level| {
            let (mut seats, mut solos, mut alive) = (0u64, 0u64, 0u64);
            let (mut share, mut centres) = (0.0, 0.0);
            let (mut decisions, mut nanos, mut slowest) = (0u64, 0u128, 0u128);
            for r in &reports {
                let s = shares(r);
                for (i, &l) in r.seat_levels.iter().enumerate() {
                    if l != level {
                        continue;
                    }
                    seats += 1;
                    share += s[i];
                    centres += r.centres[i] as f64;
                    alive += u64::from(r.centres[i] > 0);
                    solos += u64::from(r.solo.as_ref() == Some(&map.powers()[i].code));
                }
                if let Some(&(d, n, m)) = r.think.get(&level) {
                    decisions += d;
                    nanos += n;
                    slowest = slowest.max(m);
                }
            }
            LevelRow {
                level: level.name(),
                seats,
                solos,
                win_share: per(share, seats),
                mean_centres: per(centres, seats),
                survival: per(alive as f64, seats),
                decisions,
                mean_decision_us: per(nanos as f64 / 1e3, decisions),
                max_decision_us: slowest as f64 / 1e3,
            }
        })
        .collect();

    let mut matchups = Vec::new();
    for &a in &levels {
        for &b in &levels {
            if a == b {
                continue;
            }
            let (mut pairs, mut ahead, mut lead) = (0u64, 0.0, 0.0);
            for r in &reports {
                for (i, &li) in r.seat_levels.iter().enumerate() {
                    for (j, &lj) in r.seat_levels.iter().enumerate() {
                        if li != a || lj != b {
                            continue;
                        }
                        pairs += 1;
                        lead += r.centres[i] as f64 - r.centres[j] as f64;
                        ahead += match r.centres[i].cmp(&r.centres[j]) {
                            std::cmp::Ordering::Greater => 1.0,
                            std::cmp::Ordering::Equal => 0.5,
                            std::cmp::Ordering::Less => 0.0,
                        };
                    }
                }
            }
            matchups.push(Matchup {
                level: a.name(),
                against: b.name(),
                pairs,
                ahead: 100.0 * per(ahead, pairs),
                mean_centre_lead: per(lead, pairs),
            });
        }
    }

    let solos = reports.iter().filter(|r| r.solo.is_some()).count() as u64;
    let mut draw_sizes: BTreeMap<usize, u64> = BTreeMap::new();
    for r in reports.iter().filter(|r| r.solo.is_none()) {
        *draw_sizes.entry(r.survivors).or_default() += 1;
    }
    let phases: u64 = reports.iter().map(|r| r.phases as u64).sum();
    let illegal_orders: u64 = reports.iter().map(|r| r.illegal).sum();
    let incomplete_decisions: u64 = reports.iter().map(|r| r.incomplete).sum();
    let replay_divergences = reports.iter().filter(|r| !r.replay_ok).count() as u64;
    let rejected_orders: u64 = reports.iter().map(|r| r.rejected).sum();
    let contradicting: u64 = reports.iter().map(|r| r.contradictions).sum();
    let supports: u64 = reports.iter().map(|r| r.supports).sum();
    let void_supports: u64 = reports.iter().map(|r| r.void_supports).sum();
    let convoys: u64 = reports.iter().map(|r| r.convoys).sum();
    let void_convoys: u64 = reports.iter().map(|r| r.void_convoys).sum();

    let mut failures = Vec::new();
    if illegal_orders > 0 {
        failures.push(format!("{illegal_orders} orders were judged illegal"));
    }
    if incomplete_decisions > 0 {
        failures.push(format!(
            "{incomplete_decisions} decisions did not cover every unit or the full allowance"
        ));
    }
    if rejected_orders > 0 {
        failures.push(format!(
            "{rejected_orders} orders proposed by the planner were refused by the validator"
        ));
    }
    if contradicting > 0 {
        failures.push(format!(
            "{contradicting} orders contradicted another order of the same power"
        ));
    }
    if void_supports + void_convoys > 0 {
        failures.push(format!(
            "{void_supports} supports and {void_convoys} convoys were adjudicated void: \
             a bot ordered help for something its own power did not order"
        ));
    }
    if replay_divergences > 0 {
        failures.push(format!(
            "{replay_divergences} saved games did not replay to the same position"
        ));
    }
    if config.check_strength {
        // `levels` is strongest first: each must beat the next one down
        for pair in levels.windows(2) {
            let m: &Matchup = matchups
                .iter()
                .find(|m| m.level == pair[0].name() && m.against == pair[1].name())
                .expect("every pair has a matchup");
            if m.pairs == 0 || m.ahead < 50.0 + config.margin || m.mean_centre_lead <= 0.0 {
                failures.push(format!(
                    "strength order: {} finished ahead of {} in only {:.1}% of {} pairings \
                     (mean lead {:+.2} centres); at least {:.1}% is required",
                    m.level,
                    m.against,
                    m.ahead,
                    m.pairs,
                    m.mean_centre_lead,
                    50.0 + config.margin
                ));
            }
        }
    }

    Summary {
        games,
        seed: config.seed,
        max_year: config.max_year,
        levels: config.levels.iter().map(|l| l.name()).collect(),
        jobs,
        seconds,
        games_per_second: if seconds > 0.0 {
            games as f64 / seconds
        } else {
            0.0
        },
        phases,
        mean_phases: per(phases as f64, games),
        mean_final_year: per(reports.iter().map(|r| f64::from(r.final_year)).sum(), games),
        solos,
        solo_rate: per(solos as f64, games),
        draw_sizes,
        orders: reports.iter().map(|r| r.orders).sum(),
        illegal_orders,
        incomplete_decisions,
        rejected_orders,
        contradictions: contradicting,
        supports,
        void_supports,
        convoys,
        void_convoys,
        replay_divergences,
        powers,
        by_level,
        matchups,
        failures,
        reports,
    }
}

impl Summary {
    pub fn to_markdown(&self) -> String {
        let mut s = String::new();
        let _ = writeln!(s, "# Cabal arena\n");
        let _ = writeln!(
            s,
            "{} games to {}, seed {}, levels {}, {} threads.\n",
            self.games,
            self.max_year,
            self.seed,
            self.levels.join(","),
            self.jobs
        );
        let _ = writeln!(s, "| Measure | Value |\n|---|---|");
        let _ = writeln!(
            s,
            "| Throughput | {:.1} games per second ({:.1} s) |",
            self.games_per_second, self.seconds
        );
        let _ = writeln!(
            s,
            "| Average length | {:.1} phases, ending in {:.1} |",
            self.mean_phases, self.mean_final_year
        );
        let _ = writeln!(
            s,
            "| Solos | {} of {} ({:.1}%) |",
            self.solos,
            self.games,
            100.0 * self.solo_rate
        );
        let draws: Vec<String> = self
            .draw_sizes
            .iter()
            .map(|(size, n)| format!("{size}-way: {n}"))
            .collect();
        let _ = writeln!(
            s,
            "| Draws by size | {} |",
            if draws.is_empty() {
                "none".to_string()
            } else {
                draws.join(", ")
            }
        );
        let _ = writeln!(s, "| Orders adjudicated | {} |", self.orders);
        let _ = writeln!(s, "| Illegal orders | {} |", self.illegal_orders);
        let _ = writeln!(
            s,
            "| Incomplete decisions | {} |",
            self.incomplete_decisions
        );
        let _ = writeln!(
            s,
            "| Orders refused by the validator | {} |",
            self.rejected_orders
        );
        let _ = writeln!(s, "| Self-contradicting orders | {} |", self.contradictions);
        let _ = writeln!(
            s,
            "| Void supports | {} of {} |",
            self.void_supports, self.supports
        );
        let _ = writeln!(
            s,
            "| Void convoys | {} of {} |",
            self.void_convoys, self.convoys
        );
        let _ = writeln!(s, "| Replay divergences | {} |", self.replay_divergences);

        let _ = writeln!(s, "\n## By power\n");
        let _ = writeln!(
            s,
            "| Power | Solos | Win share | Mean centres | Survival |\n|---|---|---|---|---|"
        );
        for p in &self.powers {
            let _ = writeln!(
                s,
                "| {} | {} | {:.1}% | {:.2} | {:.1}% |",
                p.power,
                p.solos,
                100.0 * p.win_share,
                p.mean_centres,
                100.0 * p.survival
            );
        }

        let _ = writeln!(s, "\n## By level\n");
        let _ = writeln!(
            s,
            "| Level | Seats | Solos | Win share per seat | Mean centres | Survival | Mean decision | Slowest decision |\n|---|---|---|---|---|---|---|---|"
        );
        for l in &self.by_level {
            let _ = writeln!(
                s,
                "| {} | {} | {} | {:.1}% | {:.2} | {:.1}% | {:.2} ms | {:.2} ms |",
                l.level,
                l.seats,
                l.solos,
                100.0 * l.win_share,
                l.mean_centres,
                100.0 * l.survival,
                l.mean_decision_us / 1e3,
                l.max_decision_us / 1e3
            );
        }

        if !self.matchups.is_empty() {
            let _ = writeln!(s, "\n## Level against level\n");
            let _ = writeln!(
                s,
                "Every pair of seats in the same game with different levels. \"Ahead\" is how \
                 often the row level finished with more centres than the column level (ties count half).\n"
            );
            let _ = writeln!(
                s,
                "| Level | Against | Pairings | Ahead | Mean centre lead |\n|---|---|---|---|---|"
            );
            for m in &self.matchups {
                let _ = writeln!(
                    s,
                    "| {} | {} | {} | {:.1}% | {:+.2} |",
                    m.level, m.against, m.pairs, m.ahead, m.mean_centre_lead
                );
            }
        }

        let _ = writeln!(s, "\n## Verdict\n");
        if self.failures.is_empty() {
            let _ = writeln!(s, "PASS");
        } else {
            for f in &self.failures {
                let _ = writeln!(s, "- FAIL: {f}");
            }
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn arguments_parse_and_reject_nonsense() {
        let c = parse_args(&args(&[
            "--games",
            "12",
            "--seed",
            "9",
            "--jobs",
            "2",
            "--max-year",
            "1905",
            "--levels",
            "hard,easy",
            "--out",
            "x",
            "--no-games",
            "--check-strength",
            "--margin",
            "7.5",
        ]))
        .unwrap();
        assert_eq!((c.games, c.seed, c.jobs, c.max_year), (12, 9, 2, 1905));
        assert_eq!(c.levels, [Level::Hard, Level::Easy]);
        assert!(!c.save_games && c.check_strength);
        assert_eq!(c.margin, 7.5);
        assert!(parse_args(&args(&["--games"])).is_err());
        assert!(parse_args(&args(&["--games", "many"])).is_err());
        assert!(parse_args(&args(&["--levels", "hard,impossible"])).is_err());
        assert!(parse_args(&args(&["--max-year", "1800"])).is_err());
        assert!(parse_args(&args(&["--frobnicate"])).is_err());
    }

    #[test]
    fn every_power_plays_every_level_once_per_block() {
        let config = Config::default();
        let n = config.levels.len() as u64;
        for block in 0..20 {
            let mut seen = vec![Vec::new(); 7];
            for index in block * n..(block + 1) * n {
                let seats = seating(&config, index, 7);
                // three levels over seven seats: every game has 3, 2 and 2 of them
                for &level in &config.levels {
                    let count = seats.iter().filter(|&&l| l == level).count();
                    assert!((2..=3).contains(&count), "{seats:?}");
                }
                for (power, &level) in seats.iter().enumerate() {
                    seen[power].push(level);
                }
            }
            for levels in &mut seen {
                levels.sort();
                assert_eq!(*levels, [Level::Easy, Level::Standard, Level::Hard]);
            }
        }
        assert_ne!(
            seating(&config, 0, 7),
            seating(&config, 3, 7),
            "blocks reseat"
        );
    }

    #[test]
    fn the_strength_check_reports_an_inverted_order() {
        // demand that standard finish ahead of easy 95% of the time: the gate must trip
        let config = Config {
            games: 4,
            max_year: 1903,
            levels: vec![Level::Easy, Level::Standard],
            save_games: false,
            check_strength: true,
            margin: 45.0,
            ..Config::default()
        };
        let summary = play_all(&config).unwrap();
        assert_eq!(summary.illegal_orders, 0);
        assert_eq!(summary.replay_divergences, 0);
        assert!(
            summary
                .failures
                .iter()
                .any(|f| f.contains("strength order")),
            "a 95% requirement over four short games cannot be met: {:?}",
            summary.failures
        );
        assert!(summary.to_markdown().contains("FAIL: strength order"));
    }
}
