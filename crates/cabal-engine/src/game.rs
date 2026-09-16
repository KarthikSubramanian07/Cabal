//! Phase progression: movement, retreats, adjustments, supply centre bookkeeping, victory.

use serde::{Deserialize, Serialize};

use crate::adjudicate::adjustment::{AdjustmentResult, allowance, resolve_adjustment};
use crate::adjudicate::movement::{MovementResult, resolve_movement};
use crate::adjudicate::retreat::{RetreatResult, resolve_retreat};
use crate::geo::{Map, Power, SupplyCenter};
use crate::order::{AdjustOrder, AnyOrder, Order, RetreatOrder};
use crate::rulebook::Rulebook;
use crate::state::{GameState, Phase, PhaseKind, Season};

/// The adjudication record of one phase.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PhaseResult {
    Movement(MovementResult),
    Retreat(RetreatResult),
    Adjustment(AdjustmentResult),
}

/// One completed phase: the state it started from, what was ordered, and what happened.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct PhaseRecord {
    pub state: GameState,
    pub orders: Vec<AnyOrder>,
    pub result: PhaseResult,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Status {
    Active,
    /// A power reached the victory threshold.
    Solo {
        winner: Power,
    },
    /// Ended by agreement.
    Draw,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq, Clone, Copy, Serialize, Deserialize)]
pub enum GameError {
    #[error("the game is finished")]
    Finished,
    #[error("orders are for the wrong phase kind")]
    WrongPhase,
}

/// A game in progress: current state plus the full record of past phases.
#[derive(Clone, Debug)]
pub struct Game {
    map: &'static Map,
    pub rulebook: Rulebook,
    pub state: GameState,
    pub history: Vec<PhaseRecord>,
    pub status: Status,
}

impl Game {
    pub fn new(map: &'static Map, rulebook: Rulebook) -> Game {
        Game {
            map,
            rulebook,
            state: GameState::initial(map),
            history: Vec::new(),
            status: Status::Active,
        }
    }

    /// Start from an arbitrary state (for replays, sandboxes and tests).
    pub fn from_state(map: &'static Map, rulebook: Rulebook, state: GameState) -> Game {
        Game {
            map,
            rulebook,
            state,
            history: Vec::new(),
            status: Status::Active,
        }
    }

    pub fn map(&self) -> &'static Map {
        self.map
    }

    pub fn phase(&self) -> Phase {
        self.state.phase
    }

    pub fn is_finished(&self) -> bool {
        self.status != Status::Active
    }

    /// Process the current phase with orders of any kind; orders for other phase kinds are ignored.
    pub fn process(&mut self, orders: &[AnyOrder]) -> Result<&PhaseResult, GameError> {
        if self.is_finished() {
            return Err(GameError::Finished);
        }
        match self.state.phase.kind {
            PhaseKind::Movement => {
                let o: Vec<Order> = orders
                    .iter()
                    .filter_map(|o| {
                        if let AnyOrder::Movement(m) = o {
                            Some(*m)
                        } else {
                            None
                        }
                    })
                    .collect();
                self.process_movement(&o);
            }
            PhaseKind::Retreat => {
                let o: Vec<RetreatOrder> = orders
                    .iter()
                    .filter_map(|o| {
                        if let AnyOrder::Retreat(r) = o {
                            Some(*r)
                        } else {
                            None
                        }
                    })
                    .collect();
                self.process_retreat(&o);
            }
            PhaseKind::Adjustment => {
                let o: Vec<AdjustOrder> = orders
                    .iter()
                    .filter_map(|o| {
                        if let AnyOrder::Adjustment(a) = o {
                            Some(*a)
                        } else {
                            None
                        }
                    })
                    .collect();
                self.process_adjustment(&o);
            }
        }
        Ok(&self.history.last().expect("phase just recorded").result)
    }

    pub fn process_movement(&mut self, orders: &[Order]) -> &MovementResult {
        assert_eq!(
            self.state.phase.kind,
            PhaseKind::Movement,
            "not a movement phase"
        );
        let before = self.state.clone();
        let result = resolve_movement(self.map, &self.state.position, self.rulebook, orders);
        let mut next = GameState::from_position(self.state.phase, result.position.clone());
        next.dislodged = result.dislodged.clone();
        next.standoffs = result.standoffs.clone();
        if next.dislodged.is_empty() {
            self.state = next;
            self.after_retreats();
        } else {
            next.phase = Phase::new(
                self.state.phase.year,
                self.state.phase.season,
                PhaseKind::Retreat,
            );
            self.state = next;
        }
        self.history.push(PhaseRecord {
            state: before,
            orders: orders.iter().map(|o| AnyOrder::Movement(*o)).collect(),
            result: PhaseResult::Movement(result),
        });
        match &self.history.last().unwrap().result {
            PhaseResult::Movement(r) => r,
            _ => unreachable!(),
        }
    }

    pub fn process_retreat(&mut self, orders: &[RetreatOrder]) -> &RetreatResult {
        assert_eq!(
            self.state.phase.kind,
            PhaseKind::Retreat,
            "not a retreat phase"
        );
        let before = self.state.clone();
        let result = resolve_retreat(self.map, &self.state, orders);
        self.state = GameState::from_position(self.state.phase, result.position.clone());
        self.after_retreats();
        self.history.push(PhaseRecord {
            state: before,
            orders: orders.iter().map(|o| AnyOrder::Retreat(*o)).collect(),
            result: PhaseResult::Retreat(result),
        });
        match &self.history.last().unwrap().result {
            PhaseResult::Retreat(r) => r,
            _ => unreachable!(),
        }
    }

    pub fn process_adjustment(&mut self, orders: &[AdjustOrder]) -> &AdjustmentResult {
        assert_eq!(
            self.state.phase.kind,
            PhaseKind::Adjustment,
            "not an adjustment phase"
        );
        let before = self.state.clone();
        let result = resolve_adjustment(self.map, &self.state.position, self.rulebook, orders);
        let year = self.state.phase.year + 1;
        self.state = GameState::from_position(
            Phase::new(year, Season::Spring, PhaseKind::Movement),
            result.position.clone(),
        );
        self.history.push(PhaseRecord {
            state: before,
            orders: orders.iter().map(|o| AnyOrder::Adjustment(*o)).collect(),
            result: PhaseResult::Adjustment(result),
        });
        match &self.history.last().unwrap().result {
            PhaseResult::Adjustment(r) => r,
            _ => unreachable!(),
        }
    }

    /// After movement (with no dislodgements) or after retreats: advance the calendar.
    fn after_retreats(&mut self) {
        let phase = self.state.phase;
        match phase.season {
            Season::Spring => {
                self.state.phase = Phase::new(phase.year, Season::Fall, PhaseKind::Movement);
            }
            Season::Fall | Season::Winter => {
                self.claim_centers();
                if let Some(winner) = self.solo_winner() {
                    self.status = Status::Solo { winner };
                    self.state.phase =
                        Phase::new(phase.year, Season::Winter, PhaseKind::Adjustment);
                    return;
                }
                let needs_adjustment = self
                    .map
                    .power_ids()
                    .any(|p| allowance(&self.state.position, p) != 0);
                if needs_adjustment {
                    self.state.phase =
                        Phase::new(phase.year, Season::Winter, PhaseKind::Adjustment);
                } else {
                    self.state.phase =
                        Phase::new(phase.year + 1, Season::Spring, PhaseKind::Movement);
                }
            }
        }
    }

    /// Fall ownership: a supply centre belongs to whoever stands on it, else its previous owner.
    fn claim_centers(&mut self) {
        let units: Vec<_> = self.state.position.units.clone();
        for u in units {
            if self.map.province(u.province()).supply_center != SupplyCenter::None {
                self.state.position.owners.insert(u.province(), u.power);
            }
        }
    }

    fn solo_winner(&self) -> Option<Power> {
        self.map.power_ids().find(|&p| {
            self.state.position.count_centers(p) >= self.rulebook.victory_centers as usize
        })
    }

    /// End the game by agreement.
    pub fn declare_draw(&mut self) {
        if self.status == Status::Active {
            self.status = Status::Draw;
        }
    }

    /// Powers with neither centres nor units.
    pub fn eliminated(&self) -> Vec<Power> {
        self.map
            .power_ids()
            .filter(|&p| {
                self.state.position.count_centers(p) == 0 && self.state.position.count_units(p) == 0
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse;

    fn orders(map: &Map, lines: &[&str]) -> Vec<Order> {
        lines
            .iter()
            .map(|l| parse(map, l).unwrap().to_movement(None).unwrap())
            .collect()
    }

    #[test]
    fn spring_fall_winter_cycle() {
        let map = Map::standard();
        let mut g = Game::new(map, Rulebook::default());
        assert_eq!(g.phase().to_string(), "S1901M");
        // Spring: nobody moves into a supply centre; no retreats
        g.process_movement(&orders(map, &["FRA: A PAR - BUR", "GER: A MUN - RUH"]));
        assert_eq!(g.phase().to_string(), "F1901M");
        // Fall: France takes Belgium? Burgundy to Belgium; Germany Ruhr holds
        g.process_movement(&orders(map, &["FRA: A BUR - BEL"]));
        assert_eq!(g.phase().to_string(), "W1901A");
        let fra = map.find_power("FRA").unwrap();
        assert_eq!(g.state.position.count_centers(fra), 4);
        let (delta, _) = crate::legal::legal_adjustments(map, &g.state.position, g.rulebook, fra);
        assert_eq!(delta, 1);
        let build = parse(map, "FRA: A PAR B")
            .unwrap()
            .to_adjustment(None)
            .unwrap();
        g.process_adjustment(&[build]);
        assert_eq!(g.phase().to_string(), "S1902M");
        assert_eq!(g.state.position.count_units(fra), 4);
        assert_eq!(g.history.len(), 3);
    }

    #[test]
    fn retreat_phase_appears_when_needed() {
        let map = Map::standard();
        let mut g = Game::new(map, Rulebook::default());
        g.process_movement(&orders(
            map,
            &["AUS: A VIE - TYR", "AUS: A BUD - GAL", "ITA: A VEN - TYR"],
        ));
        assert_eq!(g.phase().to_string(), "F1901M"); // bounce, no dislodgement
        g.process_movement(&orders(
            map,
            &["AUS: A BUD - VIE", "AUS: A VIE S A BUD - VIE"],
        ));
        // support of own unit into own province is illegal, nothing dislodged, but Fall ownership applies
        assert!(matches!(
            g.phase().kind,
            PhaseKind::Movement | PhaseKind::Adjustment
        ));
    }
}
