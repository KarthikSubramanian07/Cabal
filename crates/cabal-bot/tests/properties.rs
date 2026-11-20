//! Property tests: on thousands of positions reached by seeded play, every decision
//! at every level is legal, complete, duplicate-free and reproducible, and nothing
//! the bot is handed makes it panic.

mod common;

use cabal_bot::{Level, decide, seed_from_str};
use cabal_engine::geo::{Map, Power, ProvinceId, Region, UnitKind};
use cabal_engine::legal::{legal_adjustments, legal_movement, legal_retreats};
use cabal_engine::order::{AdjustCommand, AnyOrder, Unit};
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::{Dislodged, GameState, Phase, PhaseKind, Position, Season};
use cabal_engine::{Game, Status};
use common::{assert_adjudicates_clean, assert_sound};
use proptest::prelude::*;

/// A second, independent generator for the walk (not the bot's own).
struct Lcg(u64);
impl Lcg {
    fn below(&mut self, n: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 33) as usize) % n.max(1)
    }
}

/// Uniformly random legal orders for one power: the walk's source of odd positions.
fn random_orders(game: &Game, p: Power, rng: &mut Lcg) -> Vec<AnyOrder> {
    let map = game.map();
    match game.phase().kind {
        PhaseKind::Movement => legal_movement(map, &game.state.position, p)
            .values()
            .map(|o| AnyOrder::Movement(o[rng.below(o.len())]))
            .collect(),
        PhaseKind::Retreat => legal_retreats(map, &game.state, p)
            .values()
            .map(|o| AnyOrder::Retreat(o[rng.below(o.len())]))
            .collect(),
        PhaseKind::Adjustment => {
            let (delta, mut legal) = legal_adjustments(map, &game.state.position, game.rulebook, p);
            legal.retain(|o| !matches!(o.command, AdjustCommand::Waive));
            let mut used = Vec::new();
            let mut out = Vec::new();
            for _ in 0..delta.unsigned_abs() {
                if legal.is_empty() {
                    break;
                }
                let o = legal.swap_remove(rng.below(legal.len()));
                let site = match o.command {
                    AdjustCommand::Build { region, .. } => region.province,
                    AdjustCommand::Disband { unit } => unit,
                    AdjustCommand::Waive => continue,
                };
                if !used.contains(&site) {
                    used.push(site);
                    out.push(AnyOrder::Adjustment(o));
                }
            }
            out
        }
    }
}

/// Easy and standard are checked for every power. The hard level spends fifteen
/// times the budget, so each position checks it for one power, chosen by the seed.
fn check_all_levels(game: &Game, seed: u64) {
    let map = game.map();
    let hard_seat = Power((seed % map.powers().len() as u64) as u8);
    for level in Level::ALL {
        let mut all = Vec::new();
        for p in map.power_ids() {
            let level = if level == Level::Hard && p != hard_seat {
                Level::Standard
            } else {
                level
            };
            let what = format!("{} {} {}", game.phase(), map.power(p).code, level.name());
            let a = decide(map, game.rulebook, &game.state, p, seed, level);
            let b = decide(map, game.rulebook, &game.state, p, seed, level);
            assert_eq!(a, b, "{what}: same inputs, different decision");
            assert_sound(&game.state, p, &a, &what);
            all.extend(a.orders);
        }
        assert_adjudicates_clean(game, &all, level.name());
    }
}

/// 64 cases by default. Each one is a game walked for up to 40 phases with the
/// easy bot checked for all seven powers at every step (about 9,000 decisions in
/// all), then every level checked where the walk stopped. The nightly Stress
/// workflow raises the count through `PROPTEST_CASES`.
fn cases() -> u32 {
    std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(64)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(cases()))]

    /// Walk a game for a while with a per-power mix of random legal orders and easy
    /// bots, checking the easy bot at every step, then check all three levels where
    /// the walk stopped.
    #[test]
    fn prop_decisions_are_legal_complete_and_deterministic(
        seed in any::<u64>(),
        plies in 0usize..40,
        bots in 0u8..128,
    ) {
        let map = Map::standard();
        let mut game = Game::new(map, Rulebook::default());
        let mut rng = Lcg(seed | 1);
        for _ in 0..plies {
            if game.status != Status::Active {
                break;
            }
            let mut orders = Vec::new();
            for p in map.power_ids() {
                let d = decide(map, game.rulebook, &game.state, p, seed, Level::Easy);
                assert_sound(&game.state, p, &d, "walk");
                if bots & (1 << p.0) != 0 {
                    orders.extend(d.orders);
                } else {
                    orders.extend(random_orders(&game, p, &mut rng));
                }
            }
            game.process(&orders).unwrap();
        }
        if game.status == Status::Active {
            check_all_levels(&game, seed);
        }
    }

    /// Arbitrary boards the rules would never produce (any unit anywhere, any
    /// ownership, any phase, made-up dislodgements, powers that do not exist):
    /// the bot must answer without panicking, and with a legal, complete order set
    /// whenever the board is on the map, whatever the phase.
    #[test]
    fn prop_never_panics_on_arbitrary_states(
        picks in prop::collection::vec((0u8..90, 0u8..9, any::<bool>(), 0usize..2), 0..40),
        owned in prop::collection::vec((0u8..90, 0u8..9), 0..40),
        dislodged in prop::collection::vec((0u8..90, 0u8..9, 0u8..90, any::<bool>()), 0..5),
        year in 1901u16..1950,
        season in 0u8..3,
        kind in 0u8..3,
        asker in 0u8..10,
        seed in any::<u64>(),
    ) {
        let map = Map::standard();
        let n = map.provinces().len() as u8;
        let mut pos = Position::default();
        for (p, power, fleet, coast) in picks {
            let pid = ProvinceId(p);
            if pos.units.iter().any(|u| u.province() == pid) {
                continue;
            }
            let region = if p < n {
                let coasts = &map.province(pid).coasts;
                Region::new(pid, coasts.get(coast % coasts.len().max(1)).copied().filter(|_| fleet))
            } else {
                Region::land(pid)
            };
            pos.units.push(Unit {
                power: Power(power),
                kind: if fleet { UnitKind::Fleet } else { UnitKind::Army },
                region,
            });
        }
        pos.units.sort_by_key(|u| u.region);
        for (p, power) in owned {
            pos.owners.insert(ProvinceId(p), Power(power));
        }
        let season = [Season::Spring, Season::Fall, Season::Winter][season as usize];
        let kind = [PhaseKind::Movement, PhaseKind::Retreat, PhaseKind::Adjustment][kind as usize];
        let mut state = GameState::from_position(Phase::new(year, season, kind), pos);
        if kind == PhaseKind::Retreat {
            for (p, power, from, by_convoy) in dislodged {
                state.dislodged.push(Dislodged {
                    unit: Unit { power: Power(power), kind: UnitKind::Army, region: Region::land(ProvinceId(p)) },
                    attacker_from: ProvinceId(from),
                    by_convoy,
                });
            }
        }
        for level in Level::ALL {
            let d = decide(map, Rulebook::default(), &state, Power(asker), seed, level);
            let again = decide(map, Rulebook::default(), &state, Power(asker), seed, level);
            prop_assert_eq!(&d, &again);
            let fits = state.position.units.iter().all(|u| u.province().0 < n && u.power.0 < 7)
                && state.position.owners.iter().all(|(p, q)| p.0 < n && q.0 < 7);
            if !fits || asker >= 7 {
                prop_assert!(d.orders.is_empty(), "a state off the map gets no orders");
            } else {
                // made-up dislodgements may name provinces, powers and attackers that
                // do not exist: the bot ignores exactly those and answers every real
                // dislodged unit soundly
                assert_sound(&on_the_map(map, &state), Power(asker), &d, "arbitrary board");
            }
        }
    }
}

#[test]
fn a_seed_serves_a_whole_game_and_changes_the_play() {
    let map = Map::standard();
    let play = |seed: u64| {
        let mut game = Game::new(map, Rulebook::default());
        while game.status == Status::Active && game.phase().year <= 1903 {
            let orders: Vec<AnyOrder> = map
                .power_ids()
                .flat_map(|p| decide(map, game.rulebook, &game.state, p, seed, Level::Easy).orders)
                .collect();
            game.process(&orders).unwrap();
        }
        game.state
    };
    assert_eq!(play(11), play(11));
    assert_ne!(
        play(11),
        play(12),
        "easy bots should not play one fixed game"
    );
}

#[test]
fn text_seeds_are_stable() {
    // FNV-1a test vectors: a server replaying a decision must get the same stream forever
    assert_eq!(seed_from_str(""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(seed_from_str("a"), 0xaf63_dc4c_8601_ec8c);
    assert_ne!(seed_from_str("game-1"), seed_from_str("game-2"));
}

#[test]
fn a_power_with_nothing_to_do_gets_no_orders() {
    let map = Map::standard();
    let mut state = GameState::initial(map);
    let france = map.find_power("FRA").unwrap();
    state.position.units.retain(|u| u.power != france);
    for level in Level::ALL {
        let d = decide(map, Rulebook::default(), &state, france, 5, level);
        assert!(d.orders.is_empty());
    }
}

/// The dislodged entries that belong to the map: a real province, a real power and a
/// real attacker. The bot answers these and ignores the rest.
fn on_the_map(map: &Map, state: &GameState) -> GameState {
    let n = map.provinces().len();
    let np = map.powers().len();
    let mut clean = state.clone();
    clean.dislodged.retain(|x| {
        (x.unit.province().0 as usize) < n
            && (x.unit.power.0 as usize) < np
            && (x.attacker_from.0 as usize) < n
    });
    clean
}

/// Pinned from a CI failure of `prop_never_panics_on_arbitrary_states`: a retreat list
/// that mixes a real dislodged unit with one belonging to a power that does not
/// exist (and, in a second case, one in a province that does not exist). The real
/// unit still gets its one legal order; the made-up entries get none.
#[test]
fn a_made_up_dislodgement_does_not_cost_a_real_unit_its_retreat() {
    let map = Map::standard();
    let aus = map.find_power("AUS").unwrap();
    let prov = |c: &str| map.find_province(c).unwrap();
    let real = Dislodged {
        unit: Unit {
            power: aus,
            kind: UnitKind::Army,
            region: Region::land(prov("VIE")),
        },
        attacker_from: prov("BOH"),
        by_convoy: false,
    };
    let ghost_power = Dislodged {
        unit: Unit {
            power: Power(7),
            kind: UnitKind::Army,
            region: Region::land(prov("BUD")),
        },
        attacker_from: prov("GAL"),
        by_convoy: false,
    };
    let ghost_province = Dislodged {
        unit: Unit {
            power: aus,
            kind: UnitKind::Army,
            region: Region::land(ProvinceId(200)),
        },
        attacker_from: prov("TRI"),
        by_convoy: false,
    };
    for extra in [ghost_power, ghost_province] {
        let mut state = GameState::from_position(
            Phase::new(1901, Season::Fall, PhaseKind::Retreat),
            Position::default(),
        );
        state.dislodged = vec![real, extra];
        let clean = on_the_map(map, &state);
        for level in Level::ALL {
            let d = decide(map, Rulebook::default(), &state, aus, 7, level);
            assert_eq!(
                d.orders.len(),
                1,
                "{}: the real unit is ordered ({extra:?})",
                level.name()
            );
            assert_sound(&clean, aus, &d, level.name());
        }
    }
}
