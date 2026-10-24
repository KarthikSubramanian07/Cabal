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

/// Checks whether a movement order refers to a unit owned by its power.
pub fn normalise(
    _map: &crate::geo::Map,
    position: &crate::state::Position,
    order: Order,
) -> Result<Order, crate::outcome::Illegal> {
    use crate::outcome::Illegal;

    let Some(unit) = position.unit_at(order.unit) else {
        return Err(Illegal::NoUnit);
    };

    if unit.power != order.power {
        return Err(Illegal::ForeignUnit);
    }

    if let Command::Move { dest, .. } = order.command {
        if dest == order.unit {
            return Err(Illegal::MoveToSelf);
        }
    }

    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::Map;
    use crate::outcome::Illegal;
    use crate::state::Position;

    #[test]
    fn normalise_rejects_foreign_unit() {
        let map = Map::standard();
        let position = Position::initial(&map);

        let unit = position.units[0];

        let order = Order {
            power: Power(255),
            unit: unit.province(),
            command: Command::Hold,
        };

        assert_eq!(normalise(&map, &position, order), Err(Illegal::ForeignUnit));
    }

    #[test]
    fn normalise_rejects_missing_unit() {
        let map = Map::standard();
        let position = Position::initial(&map);

        let order = Order {
            power: Power(0),
            unit: ProvinceId(255),
            command: Command::Hold,
        };

        assert_eq!(normalise(&map, &position, order), Err(Illegal::NoUnit));
    }
    #[test]
    fn normalise_rejects_move_to_self() {
        let map = Map::standard();
        let position = Position::initial(&map);
        let unit = position.units[0];

        let order = Order {
            power: unit.power,
            unit: unit.province(),
            command: Command::Move {
                dest: unit.province(),
                coast: None,
                via_convoy: false,
            },
        };

        assert_eq!(normalise(&map, &position, order), Err(Illegal::MoveToSelf));
    }
}
