//! Board position and phase bookkeeping.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::geo::{Map, Power, ProvinceId, Region, SupplyCenter, UnitKind};
use crate::order::Unit;

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Season {
    Spring,
    Fall,
    /// Winter only ever has an adjustment phase.
    Winter,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PhaseKind {
    Movement,
    Retreat,
    Adjustment,
}

/// A phase such as Spring 1901 Movement (`S1901M`).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub struct Phase {
    pub year: u16,
    pub season: Season,
    pub kind: PhaseKind,
}

impl Phase {
    pub const fn new(year: u16, season: Season, kind: PhaseKind) -> Self {
        Phase { year, season, kind }
    }

    pub const fn first() -> Self {
        Phase::new(1901, Season::Spring, PhaseKind::Movement)
    }

    /// Parse `S1901M`, `F1902R`, `W1903A`.
    pub fn parse(s: &str) -> Option<Phase> {
        let s = s.trim().to_ascii_uppercase();
        let b = s.as_bytes();
        if b.len() != 6 {
            return None;
        }
        let season = match b[0] {
            b'S' => Season::Spring,
            b'F' => Season::Fall,
            b'W' => Season::Winter,
            _ => return None,
        };
        let year: u16 = s[1..5].parse().ok()?;
        let kind = match b[5] {
            b'M' => PhaseKind::Movement,
            b'R' => PhaseKind::Retreat,
            b'A' => PhaseKind::Adjustment,
            _ => return None,
        };
        Some(Phase { year, season, kind })
    }
}

impl fmt::Display for Phase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self.season {
            Season::Spring => 'S',
            Season::Fall => 'F',
            Season::Winter => 'W',
        };
        let k = match self.kind {
            PhaseKind::Movement => 'M',
            PhaseKind::Retreat => 'R',
            PhaseKind::Adjustment => 'A',
        };
        write!(f, "{s}{}{k}", self.year)
    }
}

/// Units and supply centre ownership.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct Position {
    /// Sorted by region for determinism.
    pub units: Vec<Unit>,
    pub owners: BTreeMap<ProvinceId, Power>,
}

impl Position {
    /// The 1901 starting position of a map.
    pub fn initial(map: &Map) -> Position {
        let mut units: Vec<Unit> =
            map.start_units().iter().map(|&(power, kind, region)| Unit { power, kind, region }).collect();
        units.sort_by_key(|u| u.region);
        let mut owners = BTreeMap::new();
        for p in map.province_ids() {
            if let SupplyCenter::Home(power) = map.province(p).supply_center {
                owners.insert(p, power);
            }
        }
        Position { units, owners }
    }

    pub fn unit_at(&self, province: ProvinceId) -> Option<&Unit> {
        self.units.iter().find(|u| u.province() == province)
    }

    pub fn units_of(&self, power: Power) -> impl Iterator<Item = &Unit> + '_ {
        self.units.iter().filter(move |u| u.power == power)
    }

    pub fn centers_of(&self, power: Power) -> impl Iterator<Item = ProvinceId> + '_ {
        self.owners.iter().filter(move |(_, &o)| o == power).map(|(&p, _)| p)
    }

    pub fn count_centers(&self, power: Power) -> usize {
        self.centers_of(power).count()
    }

    pub fn count_units(&self, power: Power) -> usize {
        self.units_of(power).count()
    }

    pub fn add_unit(&mut self, unit: Unit) {
        self.units.push(unit);
        self.units.sort_by_key(|u| u.region);
    }

    pub fn remove_unit_at(&mut self, province: ProvinceId) -> Option<Unit> {
        let i = self.units.iter().position(|u| u.province() == province)?;
        Some(self.units.remove(i))
    }

    pub fn set_unit(&mut self, power: Power, kind: UnitKind, region: Region) {
        self.remove_unit_at(region.province);
        self.add_unit(Unit { power, kind, region });
    }
}

/// A unit dislodged during the last movement phase, awaiting a retreat.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Dislodged {
    pub unit: Unit,
    /// Province the successful attacker came from.
    pub attacker_from: ProvinceId,
    /// The attacker arrived by convoy (DATC 4.A.5: retreat to its origin is then allowed).
    pub by_convoy: bool,
}

/// Full game state between phases.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct GameState {
    pub phase: Phase,
    pub position: Position,
    /// Non-empty only during a retreat phase.
    pub dislodged: Vec<Dislodged>,
    /// Provinces where a standoff occurred in the last movement phase (no retreats allowed there).
    pub standoffs: BTreeSet<ProvinceId>,
}

impl GameState {
    pub fn initial(map: &Map) -> GameState {
        GameState {
            phase: Phase::first(),
            position: Position::initial(map),
            dislodged: Vec::new(),
            standoffs: BTreeSet::new(),
        }
    }

    pub fn from_position(phase: Phase, position: Position) -> GameState {
        GameState { phase, position, dislodged: Vec::new(), standoffs: BTreeSet::new() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_text() {
        let p = Phase::parse("F1905R").unwrap();
        assert_eq!(p, Phase::new(1905, Season::Fall, PhaseKind::Retreat));
        assert_eq!(p.to_string(), "F1905R");
        assert_eq!(Phase::first().to_string(), "S1901M");
    }

    #[test]
    fn initial_position() {
        let pos = Position::initial(Map::standard());
        assert_eq!(pos.units.len(), 22);
        assert_eq!(pos.owners.len(), 22);
    }
}
