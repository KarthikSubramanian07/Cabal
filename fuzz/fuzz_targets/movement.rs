#![no_main]
use cabal_engine::{
    Position, Rulebook,
    adjudicate::movement::resolve_movement,
    geo::{Map, Power, ProvinceId, Region, UnitKind},
    legal::legal_movement,
    order::{Unit, normalise},
};
use libfuzzer_sys::fuzz_target;
use std::collections::BTreeSet;

fuzz_target!(|data: &[u8]| {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    let map = Map::standard();
    let mut position = if mode & 1 == 0 {
        Position::initial(map)
    } else {
        Position::default()
    };
    if mode & 1 != 0 {
        for chunk in rest.chunks_exact(4).take(16) {
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
        // Exercise ownership preservation even on sparse generated positions.
        position.owners = Position::initial(map).owners;
    }
    let mut orders = Vec::new();
    for power in map.power_ids() {
        for legal in legal_movement(map, &position, power).into_values() {
            let pick = data[orders.len() % data.len()] as usize % legal.len();
            let order = legal[pick];
            let once = normalise(map, &position, order).unwrap();
            assert_eq!(normalise(map, &position, once), Ok(once));
            orders.push(order);
        }
    }
    let result = resolve_movement(map, &position, Rulebook::default(), &orders);
    orders.reverse();
    position.units.reverse();
    assert_eq!(
        result,
        resolve_movement(map, &position, Rulebook::default(), &orders)
    );
    assert_eq!(result.position.owners, position.owners);
    assert_eq!(
        result.position.units.len() + result.dislodged.len(),
        position.units.len()
    );
    let occupied: BTreeSet<_> = result.position.units.iter().map(Unit::province).collect();
    assert_eq!(occupied.len(), result.position.units.len());
    for dislodged in &result.dislodged {
        assert!(occupied.contains(&dislodged.unit.province()));
    }
});
