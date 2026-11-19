//! Criterion benches: time for one power to decide a movement phase, per level,
//! at the opening and in a crowded midgame reached by self-play.

use std::hint::black_box;

use cabal_bot::{Level, decide};
use cabal_engine::geo::Map;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::PhaseKind;
use cabal_engine::{Game, GameState};
use criterion::{Criterion, criterion_group, criterion_main};

/// Self-play with standard bots until the Spring movement phase of `year`.
fn midgame(year: u16) -> GameState {
    let map = Map::standard();
    let mut game = Game::new(map, Rulebook::default());
    while !game.is_finished()
        && !(game.phase().year >= year && game.phase().kind == PhaseKind::Movement)
    {
        let orders: Vec<_> = map
            .power_ids()
            .flat_map(|p| decide(map, game.rulebook, &game.state, p, 7, Level::Standard).orders)
            .collect();
        game.process(&orders).expect("game is active");
    }
    game.state
}

fn bench_decide(c: &mut Criterion) {
    let map = Map::standard();
    let rules = Rulebook::default();
    let opening = GameState::initial(map);
    let late = midgame(1906);
    let france = map.find_power("FRA").unwrap();
    // the busiest seat on the midgame board
    let busiest = map
        .power_ids()
        .max_by_key(|&p| late.position.count_units(p))
        .unwrap();
    for level in Level::ALL {
        c.bench_function(&format!("decide opening, France, {}", level.name()), |b| {
            b.iter(|| decide(map, rules, black_box(&opening), france, 1, level))
        });
        c.bench_function(
            &format!("decide midgame 1906, largest power, {}", level.name()),
            |b| b.iter(|| decide(map, rules, black_box(&late), busiest, 1, level)),
        );
    }
    c.bench_function("decide midgame 1906, all seven powers, standard", |b| {
        b.iter(|| {
            for p in map.power_ids() {
                black_box(decide(map, rules, black_box(&late), p, 1, Level::Standard));
            }
        })
    });
}

criterion_group!(benches, bench_decide);
criterion_main!(benches);
