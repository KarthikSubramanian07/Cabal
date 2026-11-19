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
