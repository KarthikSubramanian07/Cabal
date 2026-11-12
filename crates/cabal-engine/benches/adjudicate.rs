//! Criterion benches: full-board adjudication, legal order enumeration (opening and a
//! fleet-heavy midgame), a convoy paradox.

use cabal_engine::adjudicate::movement::resolve_movement;
use cabal_engine::geo::Map;
use cabal_engine::legal::legal_movement;
use cabal_engine::order::Order;
use cabal_engine::parse::parse;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::Position;
use std::hint::black_box;

use criterion::{Criterion, criterion_group, criterion_main};

fn orders(map: &Map, lines: &[&str]) -> Vec<Order> {
    lines
        .iter()
        .map(|l| parse(map, l).unwrap().to_movement(None).unwrap())
        .collect()
}

/// A busy Spring 1901: every unit moves.
fn opening_orders(map: &Map) -> Vec<Order> {
    orders(
        map,
        &[
            "AUS: A VIE - TRI",
            "AUS: A BUD - SER",
            "AUS: F TRI - ALB",
            "ENG: F LON - NTH",
            "ENG: F EDI - NWG",
            "ENG: A LVP - YOR",
            "FRA: A PAR - BUR",
            "FRA: A MAR - SPA",
            "FRA: F BRE - MAO",
            "GER: A BER - KIE",
            "GER: A MUN - RUH",
            "GER: F KIE - DEN",
            "ITA: A ROM - APU",
            "ITA: A VEN - TYR",
            "ITA: F NAP - ION",
            "RUS: A MOS - UKR",
            "RUS: A WAR - GAL",
            "RUS: F SEV - BLA",
            "RUS: F STP/SC - BOT",
            "TUR: A CON - BUL",
            "TUR: A SMY - CON",
            "TUR: F ANK - BLA",
        ],
    )
}

fn bench_opening(c: &mut Criterion) {
    let map = Map::standard();
    let pos = Position::initial(map);
    let o = opening_orders(map);
    c.bench_function("adjudicate spring 1901 (22 units)", |b| {
        b.iter(|| resolve_movement(map, black_box(&pos), Rulebook::default(), black_box(&o)))
    });
}

fn bench_paradox(c: &mut Criterion) {
    let map = Map::standard();
    // DATC 6.F.16, Pandin's paradox
    let lines = [
        "ENG: F LON S F WAL - ENG",
        "ENG: F WAL - ENG",
        "FRA: A BRE - LON",
        "FRA: F ENG C A BRE - LON",
        "GER: F NTH S F BEL - ENG",
        "GER: F BEL - ENG",
    ];
    let mut pos = Position::default();
    let o: Vec<Order> = lines
        .iter()
        .map(|l| {
            let p = parse(map, l).unwrap();
            let region = if p.kind == Some(cabal_engine::UnitKind::Army) {
                cabal_engine::Region::land(p.region.unwrap().province)
            } else {
                p.region.unwrap()
            };
            pos.add_unit(cabal_engine::Unit {
                power: p.power.unwrap(),
                kind: p.kind.unwrap(),
                region,
            });
            p.to_movement(None).unwrap()
        })
        .collect();
    c.bench_function("adjudicate pandin's paradox", |b| {
        b.iter(|| resolve_movement(map, black_box(&pos), Rulebook::default(), black_box(&o)))
    });
}

fn bench_legal(c: &mut Criterion) {
    let map = Map::standard();
    let pos = Position::initial(map);
    c.bench_function("legal orders, all powers, spring 1901", |b| {
        b.iter(|| {
            for p in map.power_ids() {
                black_box(legal_movement(map, &pos, p));
            }
        })
    });
}

/// A crowded midgame: 34 units, 18 of them fleets at sea, most armies on the coast.
/// Every sea fleet can convoy and almost every army can be convoyed somewhere, which is
/// the worst case for legal order enumeration (the 1901 bench has no fleet at sea).
fn midgame_position(map: &Map) -> Position {
    let units = [
        "ENG: F NAO",
        "ENG: F NWG",
        "ENG: F NTH",
        "ENG: F IRI",
        "ENG: A NWY",
        "ENG: A LON",
        "FRA: F ENG",
        "FRA: F MAO",
        "FRA: F WES",
        "FRA: A BRE",
        "FRA: A SPA",
        "GER: F HEL",
        "GER: F SKA",
        "GER: F BAL",
        "GER: A DEN",
        "GER: A KIE",
        "RUS: F BOT",
        "RUS: F BLA",
        "RUS: A STP",
        "RUS: A SEV",
        "ITA: F LYO",
        "ITA: F TYS",
        "ITA: F ION",
        "ITA: A NAP",
        "ITA: A TUN",
        "TUR: F AEG",
        "TUR: F EAS",
        "TUR: A SMY",
        "TUR: A BUL",
        "TUR: A GRE",
        "AUS: F ADR",
        "AUS: A TRI",
        "AUS: A ALB",
        "AUS: A SER",
    ];
    let mut pos = Position::default();
    for line in units {
        let p = parse(map, &format!("{line} H")).unwrap();
        let region = p.region.unwrap();
        let kind = p.kind.unwrap();
        pos.add_unit(cabal_engine::Unit {
            power: p.power.unwrap(),
            kind,
            region: if kind == cabal_engine::UnitKind::Army {
                cabal_engine::Region::land(region.province)
            } else {
                region
            },
        });
    }
    assert_eq!(pos.units.len(), 34);
    pos
}

fn bench_legal_midgame(c: &mut Criterion) {
    let map = Map::standard();
    let pos = midgame_position(map);
    let mut group = c.benchmark_group("midgame");
    group.sample_size(10);
    group.bench_function("legal orders, all powers, midgame", |b| {
        b.iter(|| {
            for p in map.power_ids() {
                black_box(legal_movement(map, black_box(&pos), p));
            }
        })
    });
    group.finish();
}

criterion_group!(
    benches,
    bench_opening,
    bench_paradox,
    bench_legal,
    bench_legal_midgame
);
criterion_main!(benches);
