//! Explanatory outcomes. Every order gets a reason, never just a Boolean.

use serde::{Deserialize, Serialize};

use crate::geo::ProvinceId;

/// Why an order was thrown out before resolution (DATC 4.E.1: illegal orders are ignored, the unit holds).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Illegal {
    /// No unit in the ordered province.
    NoUnit,
    /// The unit belongs to another power (DATC 6.A.6).
    ForeignUnit,
    /// More than one order was given to the unit (DATC 4.D.3).
    DuplicateOrder,
    /// Move to the unit's own province (DATC 6.A.4).
    MoveToSelf,
    /// Destination cannot be reached, even by convoy.
    Unreachable,
    /// Two coasts are reachable and none was named (DATC 4.B.1).
    AmbiguousCoast,
    /// Supporting itself (DATC 6.A.8).
    SupportSelf,
    /// The supporter cannot reach the supported province (DATC 6.A.10, 6.B.5).
    SupportUnreachable,
    /// No unit at the supported province, or wrong kind.
    SupportNoUnit,
    /// Convoying fleet is not in a sea zone (DATC 6.F.1).
    ConvoyNotAtSea,
    /// Convoyed unit is not an army (DATC 6.A.7).
    ConvoyNotArmy,
    /// The fleet is on no possible route for that convoy (DATC 6.G.19).
    ConvoyNoRoute,
    /// The order kind is not allowed in this phase (DATC 6.H.1 to 6.H.4).
    NotInPhase,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum MoveOutcome {
    Succeeds,
    /// No convoy chain of successful convoys (or the paradox rule failed the convoy).
    NoPath,
    /// Would dislodge the power's own unit.
    FriendlyFire,
    /// Lost or tied a head-to-head battle.
    LostHeadToHead { opponent: ProvinceId },
    /// Could not overcome the hold strength of the occupant.
    Repelled { occupant: ProvinceId },
    /// Tied or beaten by other units moving to the same province.
    Bounced { by: Vec<ProvinceId> },
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum SupportOutcome {
    Succeeds,
    /// Cut by a unit attacking the supporter.
    Cut { by: ProvinceId },
    /// The supporter was dislodged.
    Dislodged { by: ProvinceId },
    /// No matching order by the supported unit (DATC 4.E.1: void, still an order).
    Void,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum ConvoyOutcome {
    Succeeds,
    Dislodged { by: ProvinceId },
    /// Failed by the Szykman rule in a convoy paradox.
    Paradox,
    /// No matching move by the army.
    Void,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum HoldOutcome {
    Holds,
    Dislodged { by: ProvinceId },
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "order", rename_all = "snake_case")]
pub enum OrderOutcome {
    Illegal { reason: Illegal, dislodged_by: Option<ProvinceId> },
    Hold(HoldOutcome),
    Move(MoveOutcome),
    Support(SupportOutcome),
    Convoy(ConvoyOutcome),
}

impl OrderOutcome {
    /// DATC "Succeeds": the order did what it said. A hold "succeeds" when the unit is not dislodged.
    pub fn succeeds(&self) -> bool {
        match self {
            OrderOutcome::Illegal { .. } => false,
            OrderOutcome::Hold(h) => *h == HoldOutcome::Holds,
            OrderOutcome::Move(m) => *m == MoveOutcome::Succeeds,
            OrderOutcome::Support(s) => *s == SupportOutcome::Succeeds,
            OrderOutcome::Convoy(c) => *c == ConvoyOutcome::Succeeds,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum RetreatOutcome {
    Succeeds,
    /// Illegal destination (occupied, attacker's origin, standoff, unreachable). Unit disbands.
    Illegal { reason: RetreatIllegal },
    /// Another unit retreated to the same province. Both disband.
    Bounced { with: Vec<ProvinceId> },
    /// Ordered or defaulted to disband.
    Disbanded,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetreatIllegal {
    NotDislodged,
    Unreachable,
    AmbiguousCoast,
    Occupied,
    AttackerOrigin,
    Standoff,
    NotInPhase,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum AdjustOutcome {
    Succeeds,
    Illegal { reason: AdjustIllegal },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdjustIllegal {
    /// The power has no builds (or no disbands) to make.
    NothingToDo,
    /// Allowance already used by earlier orders.
    AllowanceUsed,
    NotHomeCenter,
    NotOwned,
    Occupied,
    /// Fleet inland, or coast missing / impossible.
    BadTerrain,
    NoUnit,
    ForeignUnit,
    NotInPhase,
}
