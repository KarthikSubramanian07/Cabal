//! Orders as the resolver sees them: fully typed, with provinces resolved.
//!
//! Text parsing and coast inference live in [`crate::parse`]; nothing here
//! knows about strings.

use serde::{Deserialize, Serialize};

use crate::geo::{Coast, Power, ProvinceId, Region, UnitKind};

/// A unit on the board.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub struct Unit {
    pub power: Power,
    pub kind: UnitKind,
    pub region: Region,
}

impl Unit {
    pub fn province(&self) -> ProvinceId {
        self.region.province
    }
}

/// Movement phase command.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Command {
    Hold,
    Move {
        /// Destination province; `coast` is the requested coast, if any.
        dest: ProvinceId,
        coast: Option<Coast>,
        /// The order said "via convoy".
        via_convoy: bool,
    },
    SupportHold {
        target: ProvinceId,
    },
    SupportMove {
        target: ProvinceId,
        dest: ProvinceId,
        /// Coast named in the support, if any (informational, see DATC 4.B.4).
        coast: Option<Coast>,
    },
    Convoy {
        army: ProvinceId,
        dest: ProvinceId,
    },
}

/// A movement phase order. The unit is identified by its province; the kind
/// and any coast in the order text are ignored once the unit is found
/// (DATC 4.B.5, 4.C.1, 4.C.2).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub struct Order {
    pub power: Power,
    pub unit: ProvinceId,
    pub command: Command,
}

/// Retreat phase order.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RetreatCommand {
    Retreat {
        dest: ProvinceId,
        coast: Option<Coast>,
    },
    Disband,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub struct RetreatOrder {
    pub power: Power,
    pub unit: ProvinceId,
    pub command: RetreatCommand,
}

/// Adjustment (Winter) phase order.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum AdjustCommand {
    Build {
        kind: Option<UnitKind>,
        region: Region,
    },
    Disband {
        unit: ProvinceId,
    },
    Waive,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub struct AdjustOrder {
    pub power: Power,
    pub command: AdjustCommand,
}

/// Any order, for phase-agnostic APIs.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum AnyOrder {
    Movement(Order),
    Retreat(RetreatOrder),
    Adjustment(AdjustOrder),
}
