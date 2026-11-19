//! The bundled maps as static tables.
//!
//! `build.rs` reads `data/maps/*.json`, runs each through `Map::from_json` (so
//! a bad document fails the build, not the first request) and writes the
//! validated result here as constants. Starting the engine then copies tables
//! instead of parsing 33 KB of JSON.

use super::{Coast, Power, ProvinceId, Region, SupplyCenter, Tables, Terrain, UnitKind};
#[allow(unused_imports)]
use crate::rulebook::{ConvoyIntent, DisbandDistance, Edition, RulebookOverrides};

include!(concat!(env!("OUT_DIR"), "/bundled_maps.rs"));
