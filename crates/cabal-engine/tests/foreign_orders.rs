//! An order for another power's unit is ignored (DATC 6.A.6). It must never
//! reach the owner: before this was pinned, a second order for a rival's unit
//! made that unit's own order a duplicate, and the unit held.

use cabal_engine::geo::Map;
use cabal_engine::order::Order;
use cabal_engine::outcome::{Illegal, MoveOutcome, OrderOutcome};
use cabal_engine::parse::parse;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::Position;
use cabal_engine::{MovementResult, resolve_movement};

fn adjudicate(lines: &[&str]) -> MovementResult {
    let map = Map::standard();
    let orders: Vec<Order> = lines
        .iter()
        .map(|l| parse(map, l).unwrap().to_movement(None).unwrap())
        .collect();
    resolve_movement(map, &Position::initial(map), Rulebook::default(), &orders)
}

fn at<'a>(result: &'a MovementResult, province: &str) -> &'a OrderOutcome {
    let map = Map::standard();
    result
        .outcome_at(map.find_province(province).unwrap())
        .unwrap()
}

#[test]
fn a_rival_cannot_void_an_order_by_ordering_the_same_unit() {
    // France orders Germany's Munich army; Germany's own order must stand
    for lines in [
        ["GER: A MUN - RUH", "FRA: A MUN - BUR"],
        ["FRA: A MUN - BUR", "GER: A MUN - RUH"],
        ["FRA: A MUN H", "GER: A MUN - RUH"],
    ] {
        let result = adjudicate(&lines);
        assert_eq!(
            at(&result, "mun"),
            &OrderOutcome::Move(MoveOutcome::Succeeds),
            "{lines:?}"
        );
    }
}

#[test]
fn two_orders_from_the_owner_are_still_duplicates() {
    let result = adjudicate(&["GER: A MUN - RUH", "GER: A MUN - BUR", "FRA: A MUN H"]);
    assert!(matches!(
        at(&result, "mun"),
        OrderOutcome::Illegal {
            reason: Illegal::DuplicateOrder,
            ..
        }
    ));
}

#[test]
fn a_unit_ordered_only_by_a_rival_holds() {
    let result = adjudicate(&["FRA: A MUN - BUR"]);
    assert!(matches!(
        at(&result, "mun"),
        OrderOutcome::Illegal {
            reason: Illegal::ForeignUnit,
            ..
        }
    ));
    let map = Map::standard();
    assert!(
        result
            .position
            .unit_at(map.find_province("mun").unwrap())
            .is_some()
    );
}

/// The same rule in a retreat phase: France's army is dislodged from Munich,
/// and Germany files an order for it as well.
#[test]
fn a_rival_cannot_disband_a_dislodged_unit_by_ordering_it() {
    use cabal_engine::geo::{Region, UnitKind};
    use cabal_engine::order::{RetreatCommand, RetreatOrder};
    use cabal_engine::outcome::RetreatOutcome;
    use cabal_engine::resolve_retreat;
    use cabal_engine::state::{Dislodged, GameState, Phase, PhaseKind, Season};

    let map = Map::standard();
    let id = |n: &str| map.find_province(n).unwrap();
    let (france, germany) = (
        map.find_power("FRANCE").unwrap(),
        map.find_power("GERMANY").unwrap(),
    );
    let mut position = Position::default();
    position.set_unit(germany, UnitKind::Army, Region::land(id("mun")));
    let mut state = GameState::from_position(
        Phase::new(1901, Season::Spring, PhaseKind::Retreat),
        position,
    );
    state.dislodged.push(Dislodged {
        unit: cabal_engine::order::Unit {
            power: france,
            kind: UnitKind::Army,
            region: Region::land(id("mun")),
        },
        attacker_from: id("bur"),
        by_convoy: false,
    });
    let own = RetreatOrder {
        power: france,
        unit: id("mun"),
        command: RetreatCommand::Retreat {
            dest: id("tyr"),
            coast: None,
        },
    };
    let rival = |command| RetreatOrder {
        power: germany,
        unit: id("mun"),
        command,
    };
    let elsewhere = RetreatCommand::Retreat {
        dest: id("boh"),
        coast: None,
    };
    for orders in [
        vec![own],
        vec![own, rival(RetreatCommand::Disband)],
        vec![rival(RetreatCommand::Disband), own],
        vec![rival(elsewhere), own, rival(RetreatCommand::Disband)],
    ] {
        let result = resolve_retreat(map, &state, &orders);
        assert_eq!(
            result.outcome_at(id("mun")),
            Some(&RetreatOutcome::Succeeds),
            "{orders:?}"
        );
        assert_eq!(
            result.orders,
            vec![own],
            "the rival's orders are not listed"
        );
        assert!(result.position.unit_at(id("tyr")).is_some());
    }

    // ordered only by the rival, the unit disbands as if it had no order;
    // it does not go where the rival sent it
    let result = resolve_retreat(map, &state, &[rival(elsewhere)]);
    assert_eq!(
        result.outcome_at(id("mun")),
        Some(&RetreatOutcome::Disbanded)
    );
    assert!(result.position.unit_at(id("boh")).is_none());

    // two orders from the owner still disband it
    let twice = RetreatOrder {
        command: elsewhere,
        ..own
    };
    let result = resolve_retreat(map, &state, &[own, twice]);
    assert_eq!(
        result.outcome_at(id("mun")),
        Some(&RetreatOutcome::Disbanded)
    );
}
