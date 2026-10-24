//! Orders as the resolver sees them: fully typed, with provinces resolved.
//!
//! Text parsing and coast inference live in [`crate::parse`]; nothing here
//! knows about strings.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::geo::{Coast, Map, Power, ProvinceId, Region, UnitKind};
use crate::outcome::Illegal;
use crate::state::Position;

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

/// Validates a movement order against the current board position.
///
/// Returns the order unchanged when it is legal.
/// Returns an Illegal reason when the command cannot be performed.
///
/// Duplicate orders are checked separately because they require
/// examining multiple submitted orders for the same unit.
pub fn normalise(map: &Map, position: &Position, order: Order) -> Result<Order, Illegal> {
    let Some(unit) = position.unit_at(order.unit) else {
        return Err(Illegal::NoUnit);
    };

    if unit.power != order.power {
        return Err(Illegal::ForeignUnit);
    }

    let fleet_seas: BTreeSet<ProvinceId> = position
        .units
        .iter()
        .filter(|u| u.kind == UnitKind::Fleet && map.is_sea(u.province()))
        .map(|u| u.province())
        .collect();

    match order.command {
        Command::Hold => {}

        Command::Move {
            dest,
            coast,
            via_convoy: _,
        } => {
            if dest == unit.province() {
                return Err(Illegal::MoveToSelf);
            }

            match unit.kind {
                UnitKind::Army => {
                    let adjacent = map.adjacent_province(unit.region, UnitKind::Army, dest);

                    let convoy_available = crate::adjudicate::movement::convoy_possible(
                        map,
                        &fleet_seas,
                        unit.province(),
                        dest,
                    );

                    if !adjacent && !convoy_available {
                        return Err(Illegal::Unreachable);
                    }
                }

                UnitKind::Fleet => match map.fleet_destination(unit.region, dest, coast) {
                    Ok(_) => {}

                    Err(crate::geo::CoastError::Ambiguous) => {
                        return Err(Illegal::AmbiguousCoast);
                    }

                    Err(crate::geo::CoastError::Unreachable) => {
                        return Err(Illegal::Unreachable);
                    }
                },
            }
        }

        Command::SupportHold { target } => {
            if target == unit.province() {
                return Err(Illegal::SupportSelf);
            }

            if position.unit_at(target).is_none() {
                return Err(Illegal::SupportNoUnit);
            }

            if !map.adjacent_province(unit.region, unit.kind, target) {
                return Err(Illegal::SupportUnreachable);
            }
        }

        Command::SupportMove {
            target,
            dest,
            coast: _,
        } => {
            if target == unit.province() {
                return Err(Illegal::SupportSelf);
            }

            if dest == unit.province() {
                return Err(Illegal::Unreachable);
            }

            if position.unit_at(target).is_none() {
                return Err(Illegal::SupportNoUnit);
            }

            if !map.adjacent_province(unit.region, unit.kind, dest) {
                return Err(Illegal::SupportUnreachable);
            }
        }

        Command::Convoy { army, dest } => {
            if unit.kind != UnitKind::Fleet || !map.is_sea(unit.province()) {
                return Err(Illegal::ConvoyNotAtSea);
            }

            let Some(target_unit) = position.unit_at(army) else {
                return Err(Illegal::ConvoyNotArmy);
            };

            if target_unit.kind != UnitKind::Army {
                return Err(Illegal::ConvoyNotArmy);
            }

            if !map.is_coastal(army) || !map.is_coastal(dest) || army == dest {
                return Err(Illegal::Unreachable);
            }

            if !crate::adjudicate::movement::on_convoy_route(
                map,
                &fleet_seas,
                army,
                dest,
                unit.province(),
            ) {
                return Err(Illegal::ConvoyNoRoute);
            }
        }
    }

    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalise_rejects_foreign_unit() {
        let map = Map::standard();
        let position = Position::initial(map);
        let unit = position.units[0];

        let order = Order {
            power: Power(255),
            unit: unit.province(),
            command: Command::Hold,
        };

        assert_eq!(normalise(map, &position, order), Err(Illegal::ForeignUnit));
    }

    #[test]
    fn normalise_rejects_missing_unit() {
        let map = Map::standard();
        let position = Position::initial(map);

        let order = Order {
            power: Power(0),
            unit: ProvinceId(255),
            command: Command::Hold,
        };

        assert_eq!(normalise(map, &position, order), Err(Illegal::NoUnit));
    }

    #[test]
    fn normalise_rejects_move_to_self() {
        let map = Map::standard();
        let position = Position::initial(map);
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

        assert_eq!(normalise(map, &position, order), Err(Illegal::MoveToSelf));
    }

    #[test]
    fn normalise_rejects_support_self() {
        let map = Map::standard();
        let position = Position::initial(map);
        let unit = position.units[0];

        let order = Order {
            power: unit.power,
            unit: unit.province(),
            command: Command::SupportHold {
                target: unit.province(),
            },
        };

        assert_eq!(normalise(map, &position, order), Err(Illegal::SupportSelf));
    }

    #[test]
    fn normalise_accepts_hold() {
        let map = Map::standard();
        let position = Position::initial(map);
        let unit = position.units[0];

        let order = Order {
            power: unit.power,
            unit: unit.province(),
            command: Command::Hold,
        };

        assert_eq!(normalise(map, &position, order), Ok(order));
    }

    #[test]
    fn normalise_rejects_support_move_self() {
        let map = Map::standard();
        let position = Position::initial(map);
        let unit = position.units[0];

        let order = Order {
            power: unit.power,
            unit: unit.province(),
            command: Command::SupportMove {
                target: unit.province(),
                dest: ProvinceId(255),
                coast: None,
            },
        };

        assert_eq!(normalise(map, &position, order), Err(Illegal::SupportSelf));
    }

    #[test]
    fn normalise_rejects_missing_support_target() {
        let map = Map::standard();
        let position = Position::initial(map);
        let unit = position.units[0];

        let order = Order {
            power: unit.power,
            unit: unit.province(),
            command: Command::SupportHold {
                target: ProvinceId(255),
            },
        };

        assert_eq!(
            normalise(map, &position, order),
            Err(Illegal::SupportNoUnit)
        );
    }
}
