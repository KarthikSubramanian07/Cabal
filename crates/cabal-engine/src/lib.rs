//! Cabal engine: a pure, deterministic Diplomacy adjudicator.
//!
//! No I/O, no randomness, no host dependencies: the same crate runs natively
//! and in WebAssembly.

pub mod geo;

pub use geo::{Coast, Map, Power, ProvinceId, Region, UnitKind};

/// Semantic version of the rules engine, exposed to hosts.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
