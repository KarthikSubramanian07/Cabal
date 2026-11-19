//! Tactical puzzles: small positions with one clearly right answer.

mod common;

use cabal_bot::{Level, decide};
use cabal_engine::geo::{Map, ProvinceId, Region, UnitKind};
use cabal_engine::order::Unit;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::{Dislodged, GameState};
use common::{assert_sound, orders_for, position, power, state, texts};

const SEEDS: [u64; 6] = [1, 2, 3, 42, 1000, 987_654_321];
const SEARCHING: [Level; 2] = [Level::Standard, Level::Hard];

fn province(name: &str) -> ProvinceId {
    Map::standard().find_province(name).unwrap()
}

#[test]
fn takes_an_undefended_centre() {
    // Fall: a lone French army in Picardy, Belgium empty and unowned next door.
    let s = state(
        "F1901M",
        position(&["FRA A PIC"], &[("FRA", &["par", "bre", "mar"])]),
    );
    for level in Level::ALL {
        for seed in SEEDS {
            assert_eq!(
                orders_for(&s, "FRA", seed, level),
                ["A PIC - BEL"],
                "{} seed {seed}",
                level.name()
            );
        }
    }
}

#[test]
fn stays_on_a_centre_it_must_still_capture() {
    // Fall: the army walked into Belgium in Spring. Leaving now would forfeit it,
    // and Holland next door is already French, so there is nothing else to gain.
    let s = state(
        "F1901M",
        position(&["FRA A BEL"], &[("FRA", &["par", "bre", "mar", "hol"])]),
    );
    for level in SEARCHING {
        for seed in SEEDS {
            assert_eq!(orders_for(&s, "FRA", seed, level), ["A BEL H"]);
        }
    }
}

#[test]
fn supports_itself_into_a_defended_centre() {
    // Two Austrian armies next to a lone German army in Munich; nothing else is in
    // reach, so the only way to gain is one attacking with the other in support.
    let s = state(
        "F1902M",
        position(
            &["AUS A TYR", "AUS A BOH", "GER A MUN"],
            &[
                ("AUS", &["vie", "tri", "bud", "ven"]),
                ("GER", &["mun", "ber", "kie"]),
            ],
        ),
    );
    for level in SEARCHING {
        for seed in SEEDS {
            let got = orders_for(&s, "AUS", seed, level);
            let a = ["A BOH S A TYR - MUN", "A TYR - MUN"];
            let b = ["A BOH - MUN", "A TYR S A BOH - MUN"];
            assert!(
                got == a || got == b,
                "{} seed {seed}: {got:?}",
                level.name()
            );
            let d = decide(
                Map::standard(),
                Rulebook::default(),
                &s,
                power("AUS"),
                seed,
                level,
            );
            assert_eq!(d.intent.targets, [province("mun")]);
            assert_eq!(d.intent.against, [power("GER")]);
            assert_eq!(d.intent.supports.len(), 1);
            assert_eq!(d.intent.supports[0].power, power("AUS"));
            assert_eq!(d.intent.supports[0].dest, Some(province("mun")));
            assert!(d.intent.adjudications > 0 && d.intent.candidates > 0);
        }
    }
}

#[test]
fn defends_a_threatened_home_centre() {
    // Fall: an English fleet in the Channel can walk into empty Brest. The French
    // army in Paris is the only unit that can cover it.
    let s = state(
        "F1902M",
        position(
            &["FRA A PAR", "ENG F ENG"],
            &[
                ("FRA", &["par", "bre", "mar"]),
                ("ENG", &["lon", "lvp", "edi", "bel"]),
            ],
        ),
    );
    for level in SEARCHING {
        for seed in SEEDS {
            assert_eq!(
                orders_for(&s, "FRA", seed, level),
                ["A PAR - BRE"],
                "{} seed {seed}",
                level.name()
            );
            let d = decide(
                Map::standard(),
                Rulebook::default(),
                &s,
                power("FRA"),
                seed,
                level,
            );
            assert_eq!(d.intent.fears.first().map(|f| f.power), Some(power("ENG")));
        }
    }
}

#[test]
fn holds_a_centre_under_attack_and_supports_it() {
    // Fall: Munich holds a German army; French armies in Burgundy and Tyrolia can
    // attack it two to one. Whatever Berlin does, Munich itself must stay put.
    let s = state(
        "F1902M",
        position(
            &["GER A MUN", "GER A BER", "FRA A BUR", "FRA A TYR"],
            &[
                ("GER", &["mun", "ber", "kie"]),
                ("FRA", &["par", "bre", "mar", "bel", "hol", "den"]),
            ],
        ),
    );
    for level in SEARCHING {
        for seed in SEEDS {
            let got = orders_for(&s, "GER", seed, level);
            assert!(
                got.contains(&"A MUN H".to_string())
                    || got.iter().any(|o| o.starts_with("A MUN S")),
                "{} seed {seed}: Munich must not be abandoned: {got:?}",
                level.name()
            );
        }
    }
}

fn dislodge(state: &mut GameState, power_code: &str, kind: UnitKind, at: &str, from: &str) {
    state.dislodged.push(Dislodged {
        unit: Unit {
            power: power(power_code),
            kind,
            region: Region::land(province(at)),
        },
        attacker_from: province(from),
        by_convoy: false,
    });
}

#[test]
fn retreats_onto_a_centre_rather_than_into_the_fields() {
    // Fall retreat: the French army thrown out of Burgundy (from Munich) may go to
    // Paris, Marseilles, Gascony, Picardy or unowned Belgium. Belgium is a new centre.
    let mut s = state(
        "F1902R",
        position(
            &["GER A BUR", "GER A RUH"],
            &[
                ("FRA", &["par", "bre", "mar"]),
                ("GER", &["mun", "ber", "kie"]),
            ],
        ),
    );
    dislodge(&mut s, "FRA", UnitKind::Army, "bur", "mun");
    for level in SEARCHING {
        for seed in SEEDS {
            assert_eq!(orders_for(&s, "FRA", seed, level), ["A BUR R BEL"]);
        }
    }
    // In Spring nothing is captured by standing on Belgium for one phase: with the
    // enemy on the doorstep the army falls back to cover a home centre instead.
    s.phase = cabal_engine::Phase::parse("S1902R").unwrap();
    for seed in SEEDS {
        let got = orders_for(&s, "FRA", seed, Level::Hard);
        assert!(
            got == ["A BUR R PAR"] || got == ["A BUR R MAR"] || got == ["A BUR R BEL"],
            "{got:?}"
        );
    }
}

#[test]
fn never_disbands_when_it_can_retreat_and_never_bounces_itself() {
    // Two dislodged Russian armies share exactly one open square (Livonia): one of
    // them takes it, the other has nowhere to go and disbands. Both in the same
    // square would destroy both.
    let mut s = state(
        "S1903R",
        position(
            &[
                "GER A WAR",
                "GER A MOS",
                "GER A PRU",
                "GER A SIL",
                "GER A GAL",
                "GER A UKR",
                "GER A SEV",
                "GER F BOT",
                "GER F BAL",
                "GER A FIN",
                "GER A NWY",
                "GER A BAR",
            ],
            &[
                ("RUS", &["stp"]),
                ("GER", &["mun", "ber", "kie", "war", "mos"]),
            ],
        ),
    );
    dislodge(&mut s, "RUS", UnitKind::Army, "war", "pru");
    dislodge(&mut s, "RUS", UnitKind::Army, "mos", "sev");
    // Germany stands on both squares now, so the Russians are the dislodged ones only
    for level in Level::ALL {
        for seed in SEEDS {
            let d = decide(
                Map::standard(),
                Rulebook::default(),
                &s,
                power("RUS"),
                seed,
                level,
            );
            assert_sound(&s, power("RUS"), &d, "shared retreat");
            let got = texts(&s, &d);
            let retreats = got.iter().filter(|o| o.contains(" R ")).count();
            assert!(retreats >= 1, "{} seed {seed}: {got:?}", level.name());
        }
    }
}

#[test]
fn builds_fill_the_allowance_and_waive_only_when_out_of_centres() {
    // France owns six centres with three units: three builds, three free home centres.
    let three = state(
        "W1902A",
        position(
            &["FRA A BEL", "FRA A SPA", "FRA F POR"],
            &[("FRA", &["par", "bre", "mar", "bel", "spa", "por"])],
        ),
    );
    // Same, but Paris and Brest are occupied: one real build, two explicit waives.
    let one = state(
        "W1902A",
        position(
            &["FRA A PAR", "FRA F BRE", "FRA A SPA"],
            &[("FRA", &["par", "bre", "mar", "bel", "spa", "por"])],
        ),
    );
    for level in Level::ALL {
        for seed in SEEDS {
            let d = decide(
                Map::standard(),
                Rulebook::default(),
                &three,
                power("FRA"),
                seed,
                level,
            );
            assert_sound(&three, power("FRA"), &d, "three builds");
            let got = texts(&three, &d);
            assert!(got.iter().all(|o| o.ends_with(" B")), "{got:?}");

            let got = orders_for(&one, "FRA", seed, level);
            assert_eq!(
                got.iter().filter(|o| o.as_str() == "WAIVE").count(),
                2,
                "{got:?}"
            );
            assert!(
                got.iter().any(|o| o == "A MAR B" || o == "F MAR B"),
                "{got:?}"
            );
        }
    }
}

#[test]
fn an_island_power_builds_fleets_and_a_landlocked_front_gets_armies() {
    // England with only armies at home wants a navy first.
    let england = state(
        "W1902A",
        position(
            &["ENG A WAL", "ENG A YOR"],
            &[("ENG", &["lon", "lvp", "edi"])],
        ),
    );
    // Austria with two fleets already has more than enough.
    let austria = state(
        "W1902A",
        position(
            &["AUS F ALB", "AUS F ADR", "AUS A SER"],
            &[("AUS", &["vie", "tri", "bud", "ser"])],
        ),
    );
    for level in SEARCHING {
        for seed in SEEDS {
            let got = orders_for(&england, "ENG", seed, level);
            assert!(got.len() == 1 && got[0].starts_with("F "), "{got:?}");
            let got = orders_for(&austria, "AUS", seed, level);
            assert!(got.len() == 1 && got[0].starts_with("A "), "{got:?}");
        }
    }
}

#[test]
fn disbands_the_unit_doing_nothing() {
    // France must lose one unit. Four stand next to centres it does not own; the
    // army in Gascony is surrounded by quiet French centres.
    let s = state(
        "W1903A",
        position(
            &[
                "FRA A GAS",
                "FRA A BUR",
                "FRA A PIC",
                "FRA F MAO",
                "FRA A RUH",
            ],
            &[("FRA", &["par", "bre", "mar", "spa"])],
        ),
    );
    for level in SEARCHING {
        for seed in SEEDS {
            assert_eq!(orders_for(&s, "FRA", seed, level), ["A GAS D"]);
        }
    }
    for seed in SEEDS {
        let d = decide(
            Map::standard(),
            Rulebook::default(),
            &s,
            power("FRA"),
            seed,
            Level::Easy,
        );
        assert_sound(&s, power("FRA"), &d, "easy disband");
    }
}

#[test]
fn convoys_an_army_to_a_centre_it_cannot_walk_to() {
    // Fall: England holds its island, with an army in Yorkshire and a fleet in the
    // North Sea. Every prize is overseas, so the army has to be carried.
    let s = state(
        "F1901M",
        position(
            &["ENG A YOR", "ENG F NTH"],
            &[("ENG", &["lon", "lvp", "edi"])],
        ),
    );
    for level in SEARCHING {
        for seed in SEEDS {
            let got = orders_for(&s, "ENG", seed, level);
            let carried = got
                .iter()
                .any(|o| o.starts_with("A YOR - ") && o.ends_with(" VIA"))
                && got.iter().any(|o| o.starts_with("F NTH C A YOR - "));
            // the fleet taking a centre itself is just as good; idling the army at home is not
            let fleet_lands = got.iter().any(|o| {
                ["F NTH - NWY", "F NTH - DEN", "F NTH - HOL", "F NTH - BEL"].contains(&o.as_str())
            });
            assert!(
                carried || fleet_lands,
                "{} seed {seed}: {got:?}",
                level.name()
            );
        }
    }
}
