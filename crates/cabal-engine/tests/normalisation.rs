//! Explicit board positions ensure written type/coast never replaces the real unit.
use cabal_engine::adjudicate::movement::resolve_movement;
use cabal_engine::geo::{Map, UnitKind};
use cabal_engine::order::{Unit, normalise};
use cabal_engine::parse::parse;
use cabal_engine::{Position, Rulebook};

fn check(actual: &str, texts: &[&str], destination: &str) {
    let map = Map::standard();
    let parsed = parse(map, actual).unwrap();
    let unit = Unit {
        power: parsed.power.unwrap(),
        kind: parsed.kind.unwrap(),
        region: parsed.region.unwrap(),
    };
    let mut position = Position::default();
    position.add_unit(unit);
    for text in texts {
        let order = parse(map, text).unwrap().to_movement(None).unwrap();
        let once = normalise(map, &position, order).unwrap();
        assert_eq!(normalise(map, &position, once), Ok(once), "{text}");
        let result = resolve_movement(map, &position, Rulebook::default(), &[once]);
        assert!(
            result.outcomes[0].succeeds(),
            "{text}: {:?}",
            result.outcomes
        );
        assert_eq!(
            result.position.units,
            vec![Unit {
                region: map.parse_region(destination).unwrap(),
                ..unit
            }],
            "{text}"
        );
        assert!(result.dislodged.is_empty());
        assert_eq!(result.position.owners, position.owners);
    }
}

#[test]
fn datc_4_b_5_wrong_origin_coast() {
    check(
        "FRA: F SPA/SC",
        &["FRA: F SPA/NC - LYO", "FRA: F SPA - LYO"],
        "LYO",
    );
    let map = Map::standard();
    let mut position = Position::default();
    position.add_unit(Unit {
        power: map.find_power("FRA").unwrap(),
        kind: UnitKind::Fleet,
        region: map.parse_region("SPA/NC").unwrap(),
    });
    let order = parse(map, "FRA: F SPA/SC - LYO")
        .unwrap()
        .to_movement(None)
        .unwrap();
    assert!(normalise(map, &position, order).is_err());
    assert!(
        !resolve_movement(map, &position, Rulebook::default(), &[order]).outcomes[0].succeeds()
    );
}

#[test]
fn datc_4_b_6_unknown_and_irrelevant_coasts() {
    check("FRA: F MAO", &["FRA: F MAO/EC - BRE/EC"], "BRE");
    check("FRA: F GAS", &["FRA: F GAS/WC - SPA/WC"], "SPA/NC");
    check(
        "FRA: A GAS",
        &["FRA: A GAS/EC - SPA/NC", "FRA: A GAS - SPA/WC"],
        "SPA",
    );
}

#[test]
fn datc_4_c_1_missing_unit_type() {
    check("FRA: F SPA/SC", &["FRA: SPA/NC - LYO"], "LYO");
    check("FRA: A PAR", &["FRA: PAR - BUR"], "BUR");
}

#[test]
fn datc_4_c_2_wrong_unit_type() {
    check("FRA: F SPA/SC", &["FRA: A SPA/NC - LYO"], "LYO");
    check("FRA: A PAR", &["FRA: F PAR - BUR"], "BUR");
}

#[test]
fn irrelevant_support_destination_coasts_are_ignored() {
    let map = Map::standard();
    let texts = [
        "FRA: F MAO - BRE/EC",
        "FRA: F PIC S F MAO - BRE/WC",
        "ENG: F BRE H",
    ];
    let mut position = Position::default();
    let mut orders = Vec::new();
    for text in texts {
        let p = parse(map, text).unwrap();
        position.add_unit(Unit {
            power: p.power.unwrap(),
            kind: p.kind.unwrap(),
            region: p.region.unwrap(),
        });
        orders.push(p.to_movement(None).unwrap());
    }
    for &order in &orders {
        let once = normalise(map, &position, order).unwrap();
        assert_eq!(normalise(map, &position, once), Ok(once));
    }
    let result = resolve_movement(map, &position, Rulebook::default(), &orders);
    assert!(result.outcome_at(orders[0].unit).unwrap().succeeds());
    assert_eq!(result.dislodged.len(), 1);
}

#[test]
fn normalise_canonicalises_destination_coasts() {
    let map = Map::standard();
    for (actual, submitted, expected) in [
        ("FRA: A GAS", "FRA: F GAS/EC - SPA/NC", "FRA: A GAS - SPA"),
        (
            "FRA: F GAS",
            "FRA: A GAS/WC - SPA/WC",
            "FRA: F GAS - SPA/NC",
        ),
        ("FRA: F MAO", "FRA: F MAO - BRE/EC", "FRA: F MAO - BRE"),
    ] {
        let p = parse(map, actual).unwrap();
        let mut position = Position::default();
        position.add_unit(Unit {
            power: p.power.unwrap(),
            kind: p.kind.unwrap(),
            region: p.region.unwrap(),
        });
        let submitted = parse(map, submitted).unwrap().to_movement(None).unwrap();
        let expected = parse(map, expected).unwrap().to_movement(None).unwrap();
        let canonical = normalise(map, &position, submitted).unwrap();
        assert_eq!(canonical, expected);
        assert_eq!(normalise(map, &position, canonical), Ok(canonical));
    }
}
