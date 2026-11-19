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
//! - [`game`]: phase progression, supply centre bookkeeping, victory.
//! - [`json`]: MILA / Cicero compatible saved game format.
//! - [`snapshot`]: lossless restore without adjudicating the past.
//! - [`validate`]: board-aware verdicts on submitted order text.
//! - [`verify`]: replay a recorded game and report every divergence.
//! - [`pledge`]: seals (commitments) and receipts.
//!
//! No I/O, no randomness, no host dependencies: the same crate runs natively
//! and in WebAssembly.

pub mod adjudicate;
pub mod game;
pub mod geo;
pub mod json;
pub mod legal;
pub mod order;
pub mod outcome;
pub mod parse;
pub mod pledge;
pub mod rulebook;
pub mod snapshot;
pub mod state;
pub mod text;
pub mod validate;
pub mod verify;

pub use adjudicate::{
    adjustment::{AdjustmentResult, resolve_adjustment},
    movement::{MovementResult, resolve_movement},
    retreat::{RetreatResult, resolve_retreat},
};
pub use game::{Game, PhaseRecord, PhaseResult, Status};
pub use geo::{Coast, Map, Power, ProvinceId, Region, UnitKind};
pub use order::{AdjustCommand, AdjustOrder, Command, Order, RetreatCommand, RetreatOrder, Unit};
pub use outcome::OrderOutcome;
pub use rulebook::Rulebook;
pub use state::{GameState, Phase, PhaseKind, Position, Season};

/// Semantic version of the rules engine, exposed to hosts.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// What this build of the engine is, recorded by `build.rs`.
pub mod build {
    /// Short commit hash the engine was built from, or `unknown` outside a checkout.
    pub const COMMIT: &str = env!("CABAL_BUILD_COMMIT");
    /// The cargo profile by name: `debug`, `release`, or a custom one such as
    /// `wasm-release` (the WebAssembly build).
    pub const PROFILE: &str = env!("CABAL_BUILD_PROFILE");
    /// Optimisation level the engine was compiled at: `0` to `3`, `s` or `z`.
    pub const OPT_LEVEL: &str = env!("CABAL_BUILD_OPT_LEVEL");
    /// Target triple (`wasm32-unknown-unknown` in the browser and the Worker).
    pub const TARGET: &str = env!("CABAL_BUILD_TARGET");
}

#[cfg(test)]
mod build_tests {
    #[test]
    fn the_build_identifies_itself() {
        assert!(super::VERSION.split('.').count() == 3);
        assert!(!super::build::COMMIT.is_empty());
        // tests run under the dev profile, whose directory is `debug`
        assert!(
            ["debug", "release"].contains(&super::build::PROFILE),
            "{}",
            super::build::PROFILE
        );
        assert!(!super::build::OPT_LEVEL.is_empty());
        assert!(super::build::TARGET.contains('-'));
    }
}
