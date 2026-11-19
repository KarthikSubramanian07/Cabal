//! Shared test support: seeded random playouts of whole games.
//!
//! Each integration test binary compiles this module separately and uses a
//! different part of it.
#![allow(dead_code)]

pub mod golden;

use std::collections::BTreeSet;

use cabal_engine::Game;
use cabal_engine::geo::{Map, Power};
use cabal_engine::json::{MilaMessage, SavedGame, SavedPledge};
use cabal_engine::legal::{legal_adjustments, legal_movement, legal_retreats};
use cabal_engine::order::{AdjustCommand, AnyOrder, Command};
use cabal_engine::pledge::Receipt;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::PhaseKind;
use cabal_engine::{PhaseResult, Status};

/// SplitMix64: tiny, seedable, and identical on every platform, so a seed
/// always names the same game.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }

    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n` (`n` > 0). The modulo bias is irrelevant here.
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    pub fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

/// Orders for the current phase, chosen at random among the legal ones. Units
/// are sometimes left without orders, builds are sometimes waived and removals
/// are sometimes left to civil disorder, so every code path gets traffic.
pub fn random_orders(game: &Game, rng: &mut Rng) -> Vec<AnyOrder> {
    let map = game.map();
    let mut out = Vec::new();
    for power in map.power_ids() {
        match game.phase().kind {
            PhaseKind::Movement => {
                for (_, options) in legal_movement(map, &game.state.position, power) {
                    if rng.chance(8) {
                        continue; // no order: the unit holds
                    }
                    // Uniform choice drowns moves in supports; lean towards movement.
                    let moves: Vec<_> = options
                        .iter()
                        .filter(|o| matches!(o.command, Command::Move { .. }))
                        .collect();
                    let order = if !moves.is_empty() && rng.chance(55) {
                        *moves[rng.below(moves.len())]
                    } else {
                        options[rng.below(options.len())]
                    };
                    out.push(AnyOrder::Movement(order));
                }
            }
            PhaseKind::Retreat => {
                for (_, options) in legal_retreats(map, &game.state, power) {
                    if rng.chance(10) {
                        continue; // no order: disbanded
                    }
                    out.push(AnyOrder::Retreat(options[rng.below(options.len())]));
                }
            }
            PhaseKind::Adjustment => {
                let (delta, options) =
                    legal_adjustments(map, &game.state.position, game.rulebook, power);
                if delta == 0 || options.is_empty() || rng.chance(15) {
                    continue; // waive everything, or leave removals to civil disorder
                }
                let mut used = BTreeSet::new();
                for _ in 0..delta.unsigned_abs() {
                    let order = options[rng.below(options.len())];
                    let site = match order.command {
                        AdjustCommand::Build { region, .. } => Some(region.province),
                        AdjustCommand::Disband { unit } => Some(unit),
                        AdjustCommand::Waive => None,
                    };
                    if site.is_none_or(|p| used.insert(p)) {
                        out.push(AnyOrder::Adjustment(order));
                    }
                }
            }
        }
    }
    out
}

/// Play up to `phases` phases of random legal orders from `game`'s current state.
pub fn play(game: &mut Game, rng: &mut Rng, phases: usize) {
    for _ in 0..phases {
        if game.is_finished() {
            break;
        }
        let orders = random_orders(game, rng);
        game.process(&orders)
            .expect("an active game accepts orders");
    }
}

/// A fresh game on `map` under `rulebook`, played for up to `phases` phases.
pub fn playout(map: &'static Map, rulebook: Rulebook, seed: u64, phases: usize) -> Game {
    let mut game = Game::new(map, rulebook);
    play(&mut game, &mut Rng::new(seed), phases);
    game
}

/// A random game with press and pledges attached, and optionally an agreed draw.
pub fn random_game(map: &'static Map, edition: &str, seed: u64, phases: usize, draw: bool) -> Game {
    let mut rng = Rng::new(seed);
    let mut game = Game::new(map, Rulebook::by_name(edition).unwrap());
    let powers: Vec<String> = map
        .power_ids()
        .map(|p| map.power(p).name.to_ascii_uppercase())
        .collect();
    for i in 0..phases {
        if game.is_finished() {
            break;
        }
        if rng.chance(30) {
            game.record_message(MilaMessage {
                sender: powers[rng.below(powers.len())].clone(),
                recipient: powers[rng.below(powers.len())].clone(),
                phase: String::new(),
                time_sent: 1_700_000_000 + i as u64,
                message: format!("message {i}"),
            });
        }
        if rng.chance(20) {
            game.record_pledge(SavedPledge {
                id: format!("p{i}"),
                phase: game.phase().to_string(),
                pledger: powers[rng.below(powers.len())].clone(),
                audience: "ALL".into(),
                sealed: rng.chance(50),
                orders: vec!["A PAR H".into()],
                commitment: None,
                nonce: None,
                receipt: Some(Receipt::Kept),
            });
        }
        play(&mut game, &mut rng, 1);
    }
    if draw {
        game.declare_draw();
    }
    game
}

/// What a game exercises, as short tags. Computed from the replayed game so
/// the fixture manifest can be checked instead of trusted.
pub fn features(game: &Game, saved: &SavedGame) -> BTreeSet<String> {
    let mut tags = BTreeSet::new();
    let mut tag = |t: &str| {
        tags.insert(t.to_string());
    };
    let map = game.map();
    if map.name != "standard" {
        tag(&format!("map:{}", map.name));
    }
    let edition = cabal_engine::json::edition_name(game.rulebook);
    if edition != "2023" {
        tag(&format!("rulebook:{edition}"));
    }
    if game.rulebook.build_anywhere {
        tag("build_anywhere");
    }
    if game.rulebook.victory_centers != Rulebook::default().victory_centers {
        tag("short_victory");
    }
    match game.status {
        Status::Active => {}
        Status::Solo { .. } => tag("solo"),
        Status::Draw => tag("draw"),
    }
    if saved.phases.iter().any(|p| !p.messages.is_empty()) {
        tag("press");
    }
    if !game.pledges.is_empty() {
        tag("pledges");
    }
    if saved.phases.first().is_some_and(|p| p.name.ends_with('R')) {
        tag("starts_in_retreat");
    }
    for phase in &saved.phases {
        if phase
            .state
            .units
            .values()
            .flatten()
            .any(|u| u.contains('/'))
        {
            tag("split_coast");
        }
        if phase
            .state
            .cabal
            .as_ref()
            .is_some_and(|c| !c.standoffs.is_empty())
        {
            tag("standoff");
        }
        if phase
            .state
            .cabal
            .as_ref()
            .is_some_and(|c| c.dislodged.iter().any(|d| d.by_convoy))
        {
            tag("dislodged_by_convoy");
        }
    }
    for record in &game.history {
        match &record.result {
            PhaseResult::Movement(r) => {
                for (order, outcome) in r.orders.iter().zip(&r.outcomes) {
                    let ok = outcome.succeeds();
                    match order.command {
                        Command::Convoy { .. } if ok => tag("convoy"),
                        Command::SupportHold { .. } | Command::SupportMove { .. } => {
                            tag(if ok { "support" } else { "support_cut_or_void" })
                        }
                        Command::Move { .. } if !ok => tag("bounce"),
                        _ => {}
                    }
                }
                if !r.dislodged.is_empty() {
                    tag("dislodgement");
                }
            }
            PhaseResult::Retreat(r) => {
                use cabal_engine::outcome::RetreatOutcome;
                for outcome in &r.outcomes {
                    tag(match outcome {
                        RetreatOutcome::Succeeds => "retreat",
                        RetreatOutcome::Bounced { .. } => "retreat_bounce",
                        RetreatOutcome::Disbanded => "retreat_disband",
                        RetreatOutcome::Illegal { .. } => "retreat_illegal",
                    });
                }
            }
            PhaseResult::Adjustment(r) => {
                for order in &r.orders {
                    tag(match order.command {
                        AdjustCommand::Build { .. } => "build",
                        AdjustCommand::Disband { .. } => "disband",
                        AdjustCommand::Waive => "waive",
                    });
                }
                if !r.civil_disorder.is_empty() {
                    tag("civil_disorder");
                }
            }
        }
    }
    let eliminated: Vec<Power> = game.eliminated();
    if !eliminated.is_empty() {
        tag("elimination");
    }
    tags
}
