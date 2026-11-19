//! "Why did this fail": distinct codes, the units responsible, the strengths of
//! DATC 5.B, cut supports, broken convoys and paradox cycles, plus one sentence
//! a player can read.

use cabal_engine::adjudicate::movement::{
    CycleKind, MovementExplanation, Opposition, explain_movement, resolve_movement,
};
use cabal_engine::geo::{Map, UnitKind};
use cabal_engine::order::{Order, Unit};
use cabal_engine::outcome::{ConvoyOutcome, SupportOutcome};
use cabal_engine::parse::parse;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::Position;
use cabal_engine::text::{
    describe_outcome_in, explain_sentence, order_text, outcome_actors, outcome_code,
};

struct Case {
    position: Position,
    explanation: MovementExplanation,
}

/// Place every ordered unit where its order says it is, then adjudicate.
fn explain(lines: &[&str]) -> Case {
    explain_under(Rulebook::default(), lines)
}

fn explain_under(rulebook: Rulebook, lines: &[&str]) -> Case {
    let map = Map::standard();
    let mut position = Position::default();
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
        position.add_unit(Unit {
            power: p.power.unwrap(),
            kind,
            region,
        });
        orders.push(p.to_movement(None).unwrap());
    }
    let (result, explanation) = explain_movement(map, &position, rulebook, &orders);
    // explaining never changes the ruling
    assert_eq!(result, resolve_movement(map, &position, rulebook, &orders));
    assert_eq!(result.orders, explanation.orders);
    assert_eq!(explanation.why.len(), result.orders.len());
    Case {
        position,
        explanation,
    }
}

impl Case {
    fn index(&self, unit: &str) -> usize {
        let map = Map::standard();
        let p = map.find_province(unit).unwrap();
        self.explanation
            .orders
            .iter()
            .position(|o| o.unit == p)
            .unwrap()
    }
    fn code(&self, unit: &str) -> &'static str {
        outcome_code(&self.explanation.outcomes[self.index(unit)])
    }
    fn sentence(&self, unit: &str) -> String {
        explain_sentence(
            Map::standard(),
            &self.position,
            &self.explanation,
            self.index(unit),
            None,
        )
    }
    fn reason(&self, unit: &str) -> String {
        describe_outcome_in(
            Map::standard(),
            &self.position,
            &self.explanation.outcomes[self.index(unit)],
        )
    }
    fn actors(&self, unit: &str) -> Vec<String> {
        let map = Map::standard();
        let i = self.index(unit);
        outcome_actors(&self.explanation.orders[i], &self.explanation.outcomes[i])
            .into_iter()
            .map(|p| map.province(p).name.to_ascii_uppercase())
            .collect()
    }
    fn why(&self, unit: &str) -> &cabal_engine::adjudicate::movement::OrderWhy {
        &self.explanation.why[self.index(unit)]
    }
    fn name(&self, p: cabal_engine::ProvinceId) -> String {
        Map::standard().province(p).name.to_ascii_uppercase()
    }
}

#[test]
fn a_plain_bounce_names_the_other_unit_and_both_strengths() {
    let case = explain(&["FRA: A PAR - BUR", "GER: A MUN - BUR"]);
    assert_eq!(case.code("par"), "bounce");
    assert_eq!(case.reason("par"), "bounced with A MUN");
    assert_eq!(case.actors("par"), ["MUN"]);
    let why = case.why("par");
    assert_eq!(why.attack, Some(1));
    assert_eq!(why.opposition, Some(Opposition::Empty));
    assert_eq!(why.rivals.len(), 1);
    assert_eq!(case.name(why.rivals[0].unit), "MUN");
    assert_eq!(why.rivals[0].prevent, 1);
    assert_eq!(
        case.sentence("par"),
        "A PAR bounced in BUR with A MUN (strength 1): its own strength was 1, \
         and a move only succeeds when it is the strongest."
    );
    // the dependency trace has no edge for this, which is why the actors exist
    assert!(case.explanation.edges.is_empty());
}

#[test]
fn a_supported_rival_beats_an_unsupported_move() {
    let case = explain(&[
        "FRA: A PAR - BUR",
        "GER: A MUN - BUR",
        "GER: A RUH S A MUN - BUR",
    ]);
    assert_eq!(case.code("par"), "bounce");
    assert_eq!(case.code("mun"), "ok");
    assert_eq!(case.why("par").rivals[0].prevent, 2);
    assert_eq!(case.why("mun").attack, Some(2));
    assert!(case.why("mun").supports[0].counted);
    assert_eq!(
        case.sentence("mun"),
        "A MUN moved to BUR with strength 2 with support from A RUH."
    );
    assert!(case.sentence("par").contains("A MUN (strength 2)"));
}

#[test]
fn the_four_ways_a_move_fails_have_four_codes() {
    // repelled: the occupant holds with more strength
    let case = explain(&["FRA: A PAR - BUR", "GER: A BUR H"]);
    assert_eq!(case.code("par"), "repelled");
    assert_eq!(case.reason("par"), "repelled by A BUR");
    assert_eq!(
        case.why("par").opposition,
        Some(Opposition::Hold {
            occupant: Map::standard().find_province("bur").unwrap(),
            strength: 1,
            own_unit: false
        })
    );
    assert_eq!(
        case.sentence("par"),
        "A PAR attacked BUR with strength 1, not enough to dislodge A BUR, \
         which held with strength 1."
    );
    assert_eq!(
        case.sentence("bur"),
        "A BUR held with strength 1 against A PAR (strength 1)."
    );

    // head to head: both move into each other
    let case = explain(&["FRA: A PAR - BUR", "GER: A BUR - PAR"]);
    assert_eq!(case.code("par"), "head_to_head");
    assert_eq!(case.actors("par"), ["BUR"]);
    assert!(matches!(
        case.why("par").opposition,
        Some(Opposition::HeadToHead { strength: 1, .. })
    ));
    assert!(
        case.sentence("par")
            .starts_with("A PAR and A BUR moved into each other: strength 1 against 1")
    );

    // own unit: a power never dislodges itself
    let case = explain(&["FRA: A PAR - BUR", "FRA: A BUR H"]);
    assert_eq!(case.code("par"), "own_unit");
    assert_eq!(case.actors("par"), ["BUR"]);
    assert_eq!(case.why("par").attack, Some(0));
    assert!(
        case.sentence("par")
            .contains("cannot dislodge its own unit")
    );

    // no path: nobody convoys
    let case = explain(&["ENG: A LON - BEL", "ENG: F NTH H"]);
    assert_eq!(case.code("lon"), "no_path");
    assert_eq!(
        case.sentence("lon"),
        "A LON can only reach BEL by convoy, and no fleet was ordered to convoy it there."
    );
}

#[test]
fn a_cut_support_names_every_cutter_and_is_not_counted() {
    let case = explain(&[
        "FRA: A PAR - BUR",
        "FRA: A MAR S A PAR - BUR",
        "GER: A BUR H",
        "ITA: A PIE - MAR",
        "ITA: A SPA - MAR",
    ]);
    assert_eq!(case.code("mar"), "cut");
    let mut cutters: Vec<String> = case
        .why("mar")
        .cut_by
        .iter()
        .map(|&p| case.name(p))
        .collect();
    cutters.sort();
    assert_eq!(cutters, ["PIE", "SPA"]);
    let support = &case.why("par").supports[0];
    assert_eq!(case.name(support.supporter), "MAR");
    assert!(!support.counted);
    assert!(matches!(support.outcome, SupportOutcome::Cut { .. }));
    assert_eq!(support.cut_by.len(), 2);
    assert_eq!(case.why("par").attack, Some(1));
    assert_eq!(
        case.sentence("mar"),
        "The support of A MAR was cut by an attack from A PIE and A SPA."
    );
    assert!(
        case.sentence("par")
            .ends_with("Support from A MAR was cut by an attack from A PIE and A SPA.")
    );
}

#[test]
fn the_unit_under_attack_cannot_cut_the_support_against_it() {
    // Burgundy attacks the supporter, but it is the unit being attacked
    let case = explain(&[
        "FRA: A PAR - BUR",
        "FRA: A MAR S A PAR - BUR",
        "GER: A BUR - MAR",
    ]);
    assert_eq!(case.code("mar"), "ok");
    assert_eq!(case.code("par"), "ok");
    assert!(case.why("mar").cut_by.is_empty());
}

#[test]
fn support_against_the_supporters_own_power_is_given_but_not_counted() {
    let case = explain(&[
        "FRA: A PAR - BUR",
        "GER: A RUH S A PAR - BUR",
        "GER: A BUR H",
    ]);
    assert_eq!(case.code("ruh"), "ok");
    assert_eq!(case.code("par"), "repelled");
    let support = &case.why("par").supports[0];
    assert_eq!(support.outcome, SupportOutcome::Succeeds);
    assert!(!support.counted);
    assert!(case.sentence("par").contains(
        "Support from A RUH did not count: a unit never helps dislodge one of its own power."
    ));
}

#[test]
fn void_orders_say_what_did_not_match() {
    let case = explain(&[
        "FRA: A PAR S A BUR - PIC",
        "FRA: A BUR H",
        "FRA: A MAR S A GAS",
        "FRA: A GAS - SPA",
        "ENG: F NTH C A LON - BEL",
        "ENG: A LON H",
    ]);
    assert_eq!(case.code("par"), "void");
    assert_eq!(
        case.sentence("par"),
        "The support of A PAR had no effect: A BUR was not ordered to move to PIC."
    );
    assert_eq!(
        case.sentence("mar"),
        "The support of A MAR had no effect: A GAS was ordered to move, \
         and a moving unit cannot be supported in place."
    );
    assert_eq!(case.code("nth"), "void");
    assert_eq!(
        case.sentence("nth"),
        "The convoy of F NTH had no effect: A LON was not ordered to move to BEL by convoy."
    );
}

#[test]
fn a_disrupted_convoy_names_the_fleet_and_its_attacker() {
    let case = explain(&[
        "ENG: A LON - BEL",
        "ENG: F NTH C A LON - BEL",
        "GER: F HEL - NTH",
        "GER: F SKA S F HEL - NTH",
    ]);
    assert_eq!(case.code("lon"), "no_path");
    assert_eq!(case.code("nth"), "dislodged");
    let why = case.why("lon");
    assert!(why.by_convoy);
    assert_eq!(why.convoy_path, Some(false));
    assert_eq!(why.convoys.len(), 1);
    assert!(matches!(
        why.convoys[0].outcome,
        ConvoyOutcome::Dislodged { .. }
    ));
    assert_eq!(
        case.sentence("lon"),
        "The convoy carrying A LON to BEL was broken: F NTH was dislodged by F HEL."
    );
    assert_eq!(
        case.sentence("nth"),
        "F NTH was dislodged by F HEL, so its convoy failed."
    );
    let hel = case.sentence("hel");
    assert_eq!(
        hel,
        "F HEL moved to NTH with strength 2 with support from F SKA."
    );
}

#[test]
fn a_dislodged_unit_reports_the_attack_and_its_own_hold_strength() {
    let case = explain(&[
        "GER: A MUN H",
        "FRA: A BUR - MUN",
        "FRA: A RUH S A BUR - MUN",
        "AUS: A TYR S A MUN",
        "ITA: A PIE - TYR",
    ]);
    assert_eq!(case.code("mun"), "dislodged");
    assert_eq!(case.actors("mun"), ["BUR"]);
    assert_eq!(case.why("mun").hold, Some(1));
    assert_eq!(case.why("mun").attacks[0].strength, 2);
    assert_eq!(
        case.sentence("mun"),
        "A MUN was dislodged by A BUR, which attacked with strength 2 against a hold \
         strength of 1. Support from A TYR was cut by an attack from A PIE."
    );
}

#[test]
fn a_convoy_paradox_shows_its_cycle() {
    // DATC 6.F.14, the simple convoy paradox
    let case = explain(&[
        "ENG: F LON S F WAL - ENG",
        "ENG: F WAL - ENG",
        "FRA: A BRE - LON",
        "FRA: F ENG C A BRE - LON",
    ]);
    assert_eq!(case.explanation.cycles.len(), 1);
    let cycle = &case.explanation.cycles[0];
    assert_eq!(cycle.kind, CycleKind::ConvoyParadox);
    let eng = case.index("eng");
    assert!(cycle.members.contains(&eng));
    assert!(cycle.members.len() >= 3);
    assert_eq!(case.why("eng").cycle, Some(0));
    // the trace holds the same circle
    for &m in &cycle.members {
        assert!(
            case.explanation.edges.iter().any(|&(from, _)| from == m),
            "member {m} asks for nothing"
        );
    }
    let sentence = case.sentence("eng");
    assert!(
        sentence.contains("dislodged") || sentence.contains("paradox"),
        "{sentence}"
    );
    let map = Map::standard();
    for &m in &cycle.members {
        // every member is named in somebody's sentence
        let text = order_text(map, &case.position, &case.explanation.orders[m]);
        let named = cycle.members.iter().any(|&other| {
            other != m
                && explain_sentence(map, &case.position, &case.explanation, other, None)
                    .contains(&text)
        });
        assert!(named, "{text} is not named");
    }
}

#[test]
fn pandins_paradox_fails_the_convoy_by_the_szykman_rule() {
    // DATC 6.F.16
    let case = explain(&[
        "ENG: F LON S F WAL - ENG",
        "ENG: F WAL - ENG",
        "FRA: A BRE - LON",
        "FRA: F ENG C A BRE - LON",
        "GER: F NTH S F BEL - ENG",
        "GER: F BEL - ENG",
    ]);
    assert_eq!(case.code("eng"), "paradox");
    assert_eq!(case.code("bre"), "no_path");
    assert!(
        case.explanation
            .cycles
            .iter()
            .any(|c| c.kind == CycleKind::ConvoyParadox)
    );
    assert!(
        case.sentence("eng").contains("Szykman"),
        "{}",
        case.sentence("eng")
    );
    assert!(
        case.sentence("bre").contains("convoy paradox"),
        "{}",
        case.sentence("bre")
    );
}

#[test]
fn circular_movement_is_reported_as_a_cycle_that_succeeds() {
    let case = explain(&["TUR: F ANK - CON", "TUR: A CON - SMY", "TUR: A SMY - ANK"]);
    assert_eq!(case.explanation.cycles.len(), 1);
    assert_eq!(case.explanation.cycles[0].kind, CycleKind::CircularMovement);
    assert_eq!(case.explanation.cycles[0].members.len(), 3);
    for unit in ["ank", "con", "smy"] {
        assert_eq!(case.code(unit), "ok");
        assert!(case.sentence(unit).contains("circular movement"));
    }
}

#[test]
fn an_illegal_order_keeps_the_text_that_was_submitted() {
    let map = Map::standard();
    let position = Position::initial(map);
    let order = parse(map, "FRA: A PAR - MOS")
        .unwrap()
        .to_movement(None)
        .unwrap();
    let (_, explanation) = explain_movement(map, &position, Rulebook::default(), &[order]);
    let i = explanation
        .orders
        .iter()
        .position(|o| o.unit == order.unit)
        .unwrap();
    assert_eq!(outcome_code(&explanation.outcomes[i]), "illegal");
    let text = order_text(map, &position, &order);
    assert_eq!(
        explain_sentence(map, &position, &explanation, i, Some(&text)),
        "The order A PAR - MOS is illegal: the destination is not adjacent and no chain \
         of fleets could convoy there. A PAR held instead."
    );
    let reason = describe_outcome_in(map, &position, &explanation.outcomes[i]);
    assert!(!reason.contains("Unreachable"), "{reason}");
}

#[test]
fn every_opening_order_gets_a_sentence() {
    let map = Map::standard();
    let position = Position::initial(map);
    let (_, explanation) = explain_movement(map, &position, Rulebook::default(), &[]);
    for i in 0..explanation.orders.len() {
        let sentence = explain_sentence(map, &position, &explanation, i, None);
        assert!(sentence.ends_with("held."), "{sentence}");
    }
}
