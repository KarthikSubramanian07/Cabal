#![no_main]
use cabal_engine::{
    geo::Map,
    parse::{Parsed, parse},
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(&data[..data.len().min(4096)]);
    let map = Map::standard();
    if let Ok(parsed) = parse(map, &text) {
        let encoded = serde_json::to_vec(&parsed).unwrap();
        assert_eq!(parsed, serde_json::from_slice::<Parsed>(&encoded).unwrap());
        let power = map.power_ids().next();
        let _ = parsed.to_movement(power);
        let _ = parsed.to_retreat(power);
        let _ = parsed.to_adjustment(power);
    }
});
