#![no_main]
//! `Game::process` takes any orders: illegal ones, two for one unit, orders
//! for a rival's unit or for nothing at all. Whatever it was given, the game
//! it records must verify against itself, replay to the same position, and
//! read back the same rulings after a trusted restore.
use cabal_engine::{
    Game, Rulebook,
    geo::{Coast, Map, Power, ProvinceId, Region, UnitKind},
    order::{
        AdjustCommand, AdjustOrder, AnyOrder, Command, Order, RetreatCommand, RetreatOrder,
    },
    state::PhaseKind,
};
use libfuzzer_sys::fuzz_target;

fn coast(byte: u8) -> Option<Coast> {
    match byte % 8 {
        0 => Some(Coast::North),
        1 => Some(Coast::South),
        2 => Some(Coast::East),
        3 => Some(Coast::West),
        _ => None,
    }
}

/// One order of the current phase's kind from six bytes.
fn order(map: &Map, kind: PhaseKind, b: &[u8]) -> AnyOrder {
    let n = map.provinces().len();
    let province = |byte: u8| ProvinceId((usize::from(byte) % n) as u8);
    let power = Power(b[0] % map.power_ids().count() as u8);
    match kind {
        PhaseKind::Movement => AnyOrder::Movement(Order {
            power,
            unit: province(b[1]),
            command: match b[2] % 5 {
                0 => Command::Hold,
                1 => Command::Move {
                    dest: province(b[3]),
                    coast: coast(b[5]),
                    via_convoy: b[5] & 0x80 != 0,
                },
                2 => Command::SupportHold {
                    target: province(b[3]),
                },
                3 => Command::SupportMove {
                    target: province(b[3]),
                    dest: province(b[4]),
                    coast: coast(b[5]),
                },
                _ => Command::Convoy {
                    army: province(b[3]),
                    dest: province(b[4]),
                },
            },
        }),
        PhaseKind::Retreat => AnyOrder::Retreat(RetreatOrder {
            power,
            unit: province(b[1]),
            command: if b[2] % 4 == 0 {
                RetreatCommand::Disband
            } else {
                RetreatCommand::Retreat {
                    dest: province(b[3]),
                    coast: coast(b[5]),
                }
            },
        }),
        PhaseKind::Adjustment => AnyOrder::Adjustment(AdjustOrder {
            power,
            command: match b[2] % 3 {
                0 => AdjustCommand::Waive,
                1 => AdjustCommand::Disband {
                    unit: province(b[1]),
                },
                _ => AdjustCommand::Build {
                    kind: match b[3] % 3 {
                        0 => Some(UnitKind::Army),
                        1 => Some(UnitKind::Fleet),
                        _ => None,
                    },
                    region: Region::new(province(b[1]), coast(b[5])),
                },
            },
        }),
    }
}

fuzz_target!(|data: &[u8]| {
    let map = Map::standard();
    let rulebook = Rulebook::default();
    let mut game = Game::new(map, rulebook);
    // a phase is a length byte and that many six-byte orders
    let mut rest = data;
    for _ in 0..12 {
        let Some((&count, tail)) = rest.split_first() else {
            break;
        };
        let wanted = usize::from(count % 24) * 6;
        let (body, tail) = tail.split_at(wanted.min(tail.len()));
        rest = tail;
        let kind = game.phase().kind;
        let orders: Vec<AnyOrder> = body.chunks_exact(6).map(|b| order(map, kind, b)).collect();
        if game.process(&orders).is_err() {
            break; // finished
        }
    }

    let saved = game.to_saved("record");
    let text = serde_json::to_string(&saved).unwrap();
    let back: cabal_engine::json::SavedGame = serde_json::from_str(&text).unwrap();
    assert_eq!(back, saved);

    let report = Game::verify_saved(&back, rulebook).expect("own export verifies");
    assert!(report.is_clean(), "{:?}", report.divergences);
    let replayed = Game::from_saved(&back, rulebook).expect("own export replays");
    assert_eq!(replayed.state, game.state);
    assert_eq!(replayed.to_saved("record"), saved);

    let resumed = Game::resume(&back, rulebook).expect("own export resumes");
    assert_eq!(resumed.state, game.state);
    assert_eq!(resumed.to_saved("record"), saved);
    for i in 0..game.phase_count() {
        let live = game.record_at(i).unwrap();
        let archived = resumed.record_at(i).unwrap();
        // adjustment orders come back grouped by power; movement and retreat
        // rulings are listed in board order and must be identical
        if live.state.phase.kind != PhaseKind::Adjustment {
            assert_eq!(archived.result, live.result, "ruling of phase {i}");
        }
    }
});
