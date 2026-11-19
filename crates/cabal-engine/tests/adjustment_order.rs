//! Adjustment verdicts are independent of the sequence the orders arrive in.

use cabal_engine::geo::Map;
use cabal_engine::parse::parse;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::Position;

/// One power's adjustment verdicts must not depend on where another power's
/// orders sit in the list: a save groups orders by power, so a replay reads
/// them in a different sequence than they arrived in.
#[test]
fn an_adjustment_verdict_ignores_other_powers_order_of_arrival() {
    use cabal_engine::adjudicate::adjustment::resolve_adjustment;
    use cabal_engine::order::AdjustOrder;
    use cabal_engine::outcome::{AdjustIllegal, AdjustOutcome};

    let map = Map::standard();
    let id = |n: &str| map.find_province(n).unwrap();
    // Germany may build in Kiel; Italy must remove a unit and names Kiel
    let mut position = Position::initial(map);
    position.remove_unit_at(id("kie"));
    position.owners.remove(&id("nap"));
    let parse_all = |lines: &[&str]| -> Vec<AdjustOrder> {
        lines
            .iter()
            .map(|l| parse(map, l).unwrap().to_adjustment(None).unwrap())
            .collect()
    };
    let italy_first = parse_all(&["ITA: KIE D", "GER: F KIE B"]);
    let germany_first = parse_all(&["GER: F KIE B", "ITA: KIE D"]);
    let a = resolve_adjustment(map, &position, Rulebook::default(), &italy_first);
    let b = resolve_adjustment(map, &position, Rulebook::default(), &germany_first);
    let no_unit = AdjustOutcome::Illegal {
        reason: AdjustIllegal::NoUnit,
    };
    assert_eq!(a.outcomes, vec![no_unit.clone(), AdjustOutcome::Succeeds]);
    assert_eq!(b.outcomes, vec![AdjustOutcome::Succeeds, no_unit]);
    assert_eq!(a.position, b.position);
}
