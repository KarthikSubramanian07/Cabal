//! Phase adjudicators.
//!
//! - [`movement`]: the Kruijswijk partial information resolver (DATC v3.0 chapter 5.E).
//! - [`retreat`]: retreat and disband resolution (DATC 6.H).
//! - [`adjustment`]: builds, disbands and civil disorder removals (DATC 6.I, 6.J).

pub mod adjustment;
pub mod movement;
pub mod retreat;
