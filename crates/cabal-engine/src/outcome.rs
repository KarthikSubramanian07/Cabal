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
    LostHeadToHead {
        opponent: ProvinceId,
    },
    /// Could not overcome the hold strength of the occupant.
    Repelled {
        occupant: ProvinceId,
    },
    /// Tied or beaten by other units moving to the same province.
    Bounced {
        by: Vec<ProvinceId>,
    },
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum SupportOutcome {
    Succeeds,
    /// Cut by a unit attacking the supporter.
    Cut {
        by: ProvinceId,
    },
    /// The supporter was dislodged.
    Dislodged {
        by: ProvinceId,
    },
    /// No matching order by the supported unit (DATC 4.E.1: void, still an order).
    Void,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum ConvoyOutcome {
    Succeeds,
    Dislodged {
        by: ProvinceId,
    },
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
    Illegal {
        reason: Illegal,
        dislodged_by: Option<ProvinceId>,
    },
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
    Illegal {
        reason: RetreatIllegal,
    },
    /// Another unit retreated to the same province. Both disband.
    Bounced {
        with: Vec<ProvinceId>,
    },
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

impl Illegal {
    /// Stable machine code, the same text serde writes (`ambiguous_coast`).
    pub fn code(self) -> &'static str {
        match self {
            Illegal::NoUnit => "no_unit",
            Illegal::ForeignUnit => "foreign_unit",
            Illegal::DuplicateOrder => "duplicate_order",
            Illegal::MoveToSelf => "move_to_self",
            Illegal::Unreachable => "unreachable",
            Illegal::AmbiguousCoast => "ambiguous_coast",
            Illegal::SupportSelf => "support_self",
            Illegal::SupportUnreachable => "support_unreachable",
            Illegal::SupportNoUnit => "support_no_unit",
            Illegal::ConvoyNotAtSea => "convoy_not_at_sea",
            Illegal::ConvoyNotArmy => "convoy_not_army",
            Illegal::ConvoyNoRoute => "convoy_no_route",
            Illegal::NotInPhase => "not_in_phase",
        }
    }

    /// Why the order cannot be given, as a clause that finishes "the order is illegal: ...".
    pub fn message(self) -> &'static str {
        match self {
            Illegal::NoUnit => "there is no unit in that province",
            Illegal::ForeignUnit => "that unit belongs to another power",
            Illegal::DuplicateOrder => "the unit was given more than one order",
            Illegal::MoveToSelf => "a unit cannot move to the province it is in",
            Illegal::Unreachable => {
                "the destination is not adjacent and no chain of fleets could convoy there"
            }
            Illegal::AmbiguousCoast => "the destination has two coasts in reach and none was named",
            Illegal::SupportSelf => "a unit cannot support itself",
            Illegal::SupportUnreachable => {
                "a unit can only support into a province it could move to itself"
            }
            Illegal::SupportNoUnit => "there is no unit to support in that province",
            Illegal::ConvoyNotAtSea => "only a fleet in a sea province can convoy",
            Illegal::ConvoyNotArmy => "only an army can be convoyed",
            Illegal::ConvoyNoRoute => "the fleet is on no possible route for that convoy",
            Illegal::NotInPhase => "that kind of order is not allowed in this phase",
        }
    }
}

impl RetreatIllegal {
    /// Stable machine code, the same text serde writes (`attacker_origin`).
    pub fn code(self) -> &'static str {
        match self {
            RetreatIllegal::NotDislodged => "not_dislodged",
            RetreatIllegal::Unreachable => "unreachable",
            RetreatIllegal::AmbiguousCoast => "ambiguous_coast",
            RetreatIllegal::Occupied => "occupied",
            RetreatIllegal::AttackerOrigin => "attacker_origin",
            RetreatIllegal::Standoff => "standoff",
            RetreatIllegal::NotInPhase => "not_in_phase",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            RetreatIllegal::NotDislodged => "that unit was not dislodged",
            RetreatIllegal::Unreachable => "the destination is not adjacent",
            RetreatIllegal::AmbiguousCoast => {
                "the destination has two coasts in reach and none was named"
            }
            RetreatIllegal::Occupied => "the destination is occupied",
            RetreatIllegal::AttackerOrigin => {
                "a unit cannot retreat to the province its attacker came from"
            }
            RetreatIllegal::Standoff => {
                "a unit cannot retreat to a province left vacant by a standoff"
            }
            RetreatIllegal::NotInPhase => "that kind of order is not allowed in a retreat phase",
        }
    }
}

impl AdjustIllegal {
    /// Stable machine code, the same text serde writes (`not_home_center`).
    pub fn code(self) -> &'static str {
        match self {
            AdjustIllegal::NothingToDo => "nothing_to_do",
            AdjustIllegal::AllowanceUsed => "allowance_used",
            AdjustIllegal::NotHomeCenter => "not_home_center",
            AdjustIllegal::NotOwned => "not_owned",
            AdjustIllegal::Occupied => "occupied",
            AdjustIllegal::BadTerrain => "bad_terrain",
            AdjustIllegal::NoUnit => "no_unit",
            AdjustIllegal::ForeignUnit => "foreign_unit",
            AdjustIllegal::NotInPhase => "not_in_phase",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            AdjustIllegal::NothingToDo => "the power has no build or disband of that kind to make",
            AdjustIllegal::AllowanceUsed => "earlier orders already used the whole allowance",
            AdjustIllegal::NotHomeCenter => "units may only be built in a home supply centre",
            AdjustIllegal::NotOwned => "the power does not own that supply centre",
            AdjustIllegal::Occupied => "the province is occupied",
            AdjustIllegal::BadTerrain => {
                "that kind of unit cannot be built there, or a coast must be named"
            }
            AdjustIllegal::NoUnit => "there is no unit in that province",
            AdjustIllegal::ForeignUnit => "that unit belongs to another power",
            AdjustIllegal::NotInPhase => "that kind of order is not allowed in an adjustment phase",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `code()` is the public contract hosts key their copy on: it must stay
    /// equal to what serde writes into saved outcomes.
    #[test]
    fn codes_match_the_serialised_names() {
        let json = |v: serde_json::Value| v.as_str().unwrap().to_string();
        for r in [
            Illegal::NoUnit,
            Illegal::ForeignUnit,
            Illegal::DuplicateOrder,
            Illegal::MoveToSelf,
            Illegal::Unreachable,
            Illegal::AmbiguousCoast,
            Illegal::SupportSelf,
            Illegal::SupportUnreachable,
            Illegal::SupportNoUnit,
            Illegal::ConvoyNotAtSea,
            Illegal::ConvoyNotArmy,
            Illegal::ConvoyNoRoute,
            Illegal::NotInPhase,
        ] {
            assert_eq!(json(serde_json::to_value(r).unwrap()), r.code());
            assert!(!r.message().is_empty());
        }
        for r in [
            RetreatIllegal::NotDislodged,
            RetreatIllegal::Unreachable,
            RetreatIllegal::AmbiguousCoast,
            RetreatIllegal::Occupied,
            RetreatIllegal::AttackerOrigin,
            RetreatIllegal::Standoff,
            RetreatIllegal::NotInPhase,
        ] {
            assert_eq!(json(serde_json::to_value(r).unwrap()), r.code());
            assert!(!r.message().is_empty());
        }
        for r in [
            AdjustIllegal::NothingToDo,
            AdjustIllegal::AllowanceUsed,
            AdjustIllegal::NotHomeCenter,
            AdjustIllegal::NotOwned,
            AdjustIllegal::Occupied,
            AdjustIllegal::BadTerrain,
            AdjustIllegal::NoUnit,
            AdjustIllegal::ForeignUnit,
            AdjustIllegal::NotInPhase,
        ] {
            assert_eq!(json(serde_json::to_value(r).unwrap()), r.code());
            assert!(!r.message().is_empty());
        }
    }
}
