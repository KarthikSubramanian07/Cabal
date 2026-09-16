//! Canonical MILA text for orders and units.

use crate::geo::{Map, Region, UnitKind};
use crate::order::{AdjustCommand, AdjustOrder, Command, Order, RetreatCommand, RetreatOrder, Unit};
use crate::state::Position;

/// `A PAR` or `F STP/NC`.
pub fn unit_text(map: &Map, unit: &Unit) -> String {
    format!("{} {}", unit.kind.letter(), map.region_name(unit.region))
}

fn kind_at(position: &Position, p: crate::geo::ProvinceId) -> Option<UnitKind> {
    position.unit_at(p).map(|u| u.kind)
}

fn region_text(map: &Map, position: &Position, p: crate::geo::ProvinceId, coast: Option<crate::geo::Coast>) -> String {
    let _ = position;
    map.region_name(Region::new(p, coast))
}

fn unit_ref(map: &Map, position: &Position, p: crate::geo::ProvinceId) -> String {
    match position.unit_at(p) {
        Some(u) => unit_text(map, u),
        None => map.region_name(Region::land(p)),
    }
}

/// Canonical movement order text, e.g. `A PAR S A BUR - PIC`.
pub fn order_text(map: &Map, position: &Position, order: &Order) -> String {
    let me = unit_ref(map, position, order.unit);
    match order.command {
        Command::Hold => format!("{me} H"),
        Command::Move { dest, coast, via_convoy } => {
            let d = region_text(map, position, dest, coast);
            if via_convoy { format!("{me} - {d} VIA") } else { format!("{me} - {d}") }
        }
        Command::SupportHold { target } => format!("{me} S {}", unit_ref(map, position, target)),
        Command::SupportMove { target, dest, coast } => {
            format!("{me} S {} - {}", unit_ref(map, position, target), region_text(map, position, dest, coast))
        }
        Command::Convoy { army, dest } => {
            format!("{me} C {} - {}", unit_ref(map, position, army), map.region_name(Region::land(dest)))
        }
    }
}

/// Canonical retreat order text, e.g. `F BLA R SEV` or `A BUL D`.
pub fn retreat_text(map: &Map, position: &Position, order: &RetreatOrder) -> String {
    let me = unit_ref(map, position, order.unit);
    match order.command {
        RetreatCommand::Retreat { dest, coast } => format!("{me} R {}", map.region_name(Region::new(dest, coast))),
        RetreatCommand::Disband => format!("{me} D"),
    }
}

/// Canonical adjustment order text, e.g. `A PAR B`, `F BRE D`, `WAIVE`.
pub fn adjust_text(map: &Map, position: &Position, order: &AdjustOrder) -> String {
    match order.command {
        AdjustCommand::Build { kind, region } => {
            let k = kind.map(|k| k.letter()).unwrap_or('?');
            format!("{k} {} B", map.region_name(region))
        }
        AdjustCommand::Disband { unit } => {
            let k = kind_at(position, unit).map(|k| k.letter()).unwrap_or('?');
            format!("{k} {} D", map.region_name(Region::land(unit)))
        }
        AdjustCommand::Waive => "WAIVE".to_string(),
    }
}
