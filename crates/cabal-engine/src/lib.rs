//! Cabal engine: a pure, deterministic Diplomacy adjudicator.
//!
//! Layers, bottom up:
//!
//! - [`geo`]: the map graph (provinces, coasts, regions, borders).
//! - [`order`], [`parse`], [`text`]: typed orders and their MILA text form.
//! - [`rulebook`]: rulebook editions as data.
//! - [`adjudicate`]: movement (Kruijswijk partial information resolver),
//!   retreat and adjustment phases, each returning explanatory [`outcome`]s.
//! - [`legal`]: legal order enumeration per unit.
//! - [`pledge`]: seals (commitments) and receipts.
//!
//! No I/O, no randomness, no host dependencies: the same crate runs natively
//! and in WebAssembly.

pub mod adjudicate;
pub mod geo;
pub mod legal;
pub mod order;
pub mod outcome;
pub mod parse;
pub mod pledge;
pub mod rulebook;
pub mod state;
pub mod text;

pub use adjudicate::{
    adjustment::{AdjustmentResult, resolve_adjustment},
    movement::{MovementResult, resolve_movement},
    retreat::{RetreatResult, resolve_retreat},
};
pub use geo::{Coast, Map, Power, ProvinceId, Region, UnitKind};
pub use order::{AdjustCommand, AdjustOrder, Command, Order, RetreatCommand, RetreatOrder, Unit};
pub use outcome::OrderOutcome;
pub use rulebook::Rulebook;
pub use state::{GameState, Phase, PhaseKind, Position, Season};

/// Semantic version of the rules engine, exposed to hosts.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
