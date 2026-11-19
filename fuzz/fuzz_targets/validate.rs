#![no_main]
//! `validate_orders` reads whatever a player types, so it must return one
//! verdict per line on arbitrary text, and what it says must be what the
//! resolver then does: a line is `legal` exactly when adjudication keeps the
//! order, and an order thrown out is thrown out for the reason the verdict gave.
use cabal_engine::{
    Game, PhaseResult, Position, Rulebook,
    geo::{Map, Power, ProvinceId, Region, UnitKind},
    order::{AnyOrder, Unit},
    outcome::OrderOutcome,
    state::{GameState, Phase, PhaseKind, Season},
    validate::validate_orders,
};
use libfuzzer_sys::fuzz_target;

/// The opening, or up to sixteen units placed from the input.
fn board(map: &Map, mode: u8, bytes: &[u8]) -> Position {
    if mode & 1 == 0 {
        return Position::initial(map);
    }
    let mut position = Position::default();
    for chunk in bytes.chunks_exact(4).take(16) {
        let province = ProvinceId((usize::from(chunk[0]) % map.provinces().len()) as u8);
        if map.province(province).name == "swi" || position.unit_at(province).is_some() {
            continue;
        }
        let fleet = chunk[2] & 1 != 0 && !map.is_inland(province);
        if !fleet && map.is_sea(province) {
            continue;
        }
        let coasts = &map.province(province).coasts;
        let coast = if fleet && !coasts.is_empty() {
            Some(coasts[usize::from(chunk[3]) % coasts.len()])
        } else {
            None
        };
        position.add_unit(Unit {
            power: Power(chunk[1] % 7),
            kind: if fleet {
                UnitKind::Fleet
            } else {
                UnitKind::Army
            },
            region: Region::new(province, coast),
        });
    }
    position.owners = Position::initial(map).owners;
    position
}

fuzz_target!(|data: &[u8]| {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    let map = Map::standard();
    // the first 64 bytes place units, the rest is what the player typed
    let (placing, typed) = rest.split_at(rest.len().min(64));
    let text = String::from_utf8_lossy(typed);
    let lines: Vec<&str> = text.lines().take(16).collect();
    let rulebook = Rulebook::default();
    let kind = match mode >> 1 & 3 {
        0 | 1 => PhaseKind::Movement,
        2 => PhaseKind::Retreat,
        _ => PhaseKind::Adjustment,
    };
    let season = if kind == PhaseKind::Adjustment {
        Season::Winter
    } else {
        Season::Spring
    };
    let state = GameState::from_position(Phase::new(1901, season, kind), board(map, mode, placing));

    for power in map.power_ids() {
        let verdicts = validate_orders(map, &state, rulebook, power, &lines);
        assert_eq!(verdicts.len(), lines.len(), "one verdict per line");
        for (verdict, line) in verdicts.iter().zip(&lines) {
            assert_eq!(verdict.input, *line);
            assert_eq!(verdict.legal, verdict.code == "ok", "{line}: {}", verdict.code);
            assert!(!verdict.reason.is_empty(), "{line}: a verdict explains itself");
            if verdict.legal {
                assert!(verdict.order.is_some() && verdict.canonical.is_some(), "{line}");
                assert!(verdict.addresses_own_unit(), "{line}");
            }
            // canonical text is stable: validating it again gives the same text
            if let (true, Some(canonical)) = (verdict.legal, &verdict.canonical) {
                let again = validate_orders(map, &state, rulebook, power, &[canonical.as_str()])
                    .pop()
                    .unwrap();
                assert_eq!(again.canonical.as_ref(), Some(canonical), "{line}");
                assert!(again.legal, "{line}: legal alone as {canonical}: {}", again.code);
            }
        }
        if kind != PhaseKind::Movement {
            continue;
        }
        // movement: what the verdicts say is what the resolver does with the
        // same orders, unit by unit
        let orders: Vec<AnyOrder> = verdicts.iter().filter_map(|v| v.order).collect();
        let mut game = Game::from_state(map, rulebook, state.clone());
        let Ok(PhaseResult::Movement(result)) = game.process(&orders) else {
            panic!("a movement phase resolves");
        };
        for verdict in &verdicts {
            let Some(AnyOrder::Movement(order)) = verdict.order else {
                continue;
            };
            match result.outcome_at(order.unit) {
                None => assert_eq!(verdict.code, "no_unit", "{}", verdict.input),
                Some(OrderOutcome::Illegal { reason, .. }) => {
                    assert!(!verdict.legal, "{}: resolver says {reason:?}", verdict.input);
                    assert_eq!(verdict.code, reason.code(), "{}", verdict.input);
                }
                Some(_) => assert!(verdict.legal, "{}: {}", verdict.input, verdict.code),
            }
        }
    }
});
