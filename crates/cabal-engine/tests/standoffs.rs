//! Standoff bookkeeping: a province left vacant by a bounce is closed to retreats,
//! whatever happens to the units that bounced there.

use cabal_engine::geo::{Map, UnitKind};
use cabal_engine::legal::legal_retreats;
use cabal_engine::order::{Order, RetreatCommand, Unit};
use cabal_engine::parse::parse;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::{GameState, Phase, PhaseKind, Position, Season};
use cabal_engine::{MovementResult, resolve_movement};

/// Place every ordered unit where its order says it is, then adjudicate.
fn adjudicate(lines: &[&str]) -> (Position, MovementResult) {
    let map = Map::standard();
    let mut pos = Position::default();
    let mut orders: Vec<Order> = Vec::new();
    for line in lines {
        let p = parse(map, line).unwrap();
        let kind = p.kind.unwrap();
        let region = p.region.unwrap();
        let region = if kind == UnitKind::Army {
            cabal_engine::Region::land(region.province)
        } else {
            region
        };
        pos.add_unit(Unit {
            power: p.power.unwrap(),
            kind,
            region,
        });
        orders.push(p.to_movement(None).unwrap());
    }
    let result = resolve_movement(map, &pos, Rulebook::default(), &orders);
    (pos, result)
}

fn names(map: &Map, set: impl IntoIterator<Item = cabal_engine::ProvinceId>) -> Vec<String> {
    set.into_iter()
        .map(|p| map.province(p).name.to_ascii_uppercase())
        .collect()
}

fn retreat_destinations(result: &MovementResult, power: &str, from: &str) -> Vec<String> {
    let map = Map::standard();
    let mut state = GameState::from_position(
        Phase::new(1901, Season::Spring, PhaseKind::Retreat),
        result.position.clone(),
    );
    state.dislodged = result.dislodged.clone();
    state.standoffs = result.standoffs.clone();
    let options = legal_retreats(map, &state, map.find_power(power).unwrap());
    let mut out: Vec<String> = options[&map.find_province(from).unwrap()]
        .iter()
        .filter_map(|o| match o.command {
            RetreatCommand::Retreat { dest, .. } => {
                Some(map.province(dest).name.to_ascii_uppercase())
            }
            _ => None,
        })
        .collect();
    out.sort();
    out
}

/// Munich and Vienna bounce in Tyrolia while each is dislodged from a third
/// province. Tyrolia is still a standoff: neither may retreat there.
#[test]
fn bounce_is_a_standoff_even_when_every_bouncing_unit_is_dislodged() {
    let map = Map::standard();
    let (_, result) = adjudicate(&[
        "GER: A MUN - TYR",
        "AUS: A VIE - TYR",
        "FRA: A BUR - MUN",
        "FRA: A RUH S A BUR - MUN",
        "RUS: A GAL - VIE",
        "RUS: A BUD S A GAL - VIE",
    ]);
    assert_eq!(result.dislodged.len(), 2);
    assert_eq!(names(map, result.standoffs.iter().copied()), vec!["TYR"]);
    let munich = retreat_destinations(&result, "GER", "mun");
    let vienna = retreat_destinations(&result, "AUS", "vie");
    assert!(!munich.contains(&"TYR".to_string()), "{munich:?}");
    assert!(!vienna.contains(&"TYR".to_string()), "{vienna:?}");
    assert_eq!(munich, vec!["BER", "BOH", "KIE", "SIL"]);
    assert_eq!(vienna, vec!["BOH", "TRI"]);
}

/// One bouncing unit dislodged, the other not: already a standoff before the fix.
#[test]
fn bounce_with_one_dislodged_unit_is_a_standoff() {
    let map = Map::standard();
    let (_, result) = adjudicate(&[
        "GER: A MUN - TYR",
        "AUS: A VIE - TYR",
        "FRA: A BUR - MUN",
        "FRA: A RUH S A BUR - MUN",
    ]);
    assert_eq!(names(map, result.standoffs.iter().copied()), vec!["TYR"]);
}

/// The loser of a head-to-head battle has no effect on the province its
/// attacker came from, so that province is not a standoff (DATC 6.E.1 family):
/// a third unit that was dislodged elsewhere may retreat into it.
#[test]
fn head_to_head_loser_creates_no_standoff_behind_the_attacker() {
    let (_, result) = adjudicate(&[
        "GER: A MUN - BUR",
        "FRA: A BUR - MUN",
        "FRA: A RUH S A BUR - MUN",
    ]);
    assert!(result.standoffs.is_empty(), "{:?}", result.standoffs);
    assert_eq!(result.dislodged.len(), 1);
    // Burgundy is the attacker's origin, so it is closed to Munich for that reason alone.
    assert!(!retreat_destinations(&result, "GER", "mun").contains(&"BUR".to_string()));
}

/// A plain two-way bounce with nobody dislodged stays a standoff.
#[test]
fn plain_bounce_is_a_standoff() {
    let map = Map::standard();
    let (_, result) = adjudicate(&["GER: A MUN - TYR", "AUS: A VIE - TYR"]);
    assert_eq!(names(map, result.standoffs.iter().copied()), vec!["TYR"]);
}
