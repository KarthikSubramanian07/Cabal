//! Phase progression: movement, retreats, adjustments, supply centre bookkeeping, victory.

use serde::{Deserialize, Serialize};

use crate::adjudicate::adjustment::{AdjustmentResult, allowance, resolve_adjustment};
use crate::adjudicate::movement::{MovementResult, resolve_movement};
use crate::adjudicate::retreat::{RetreatResult, resolve_retreat};
use std::collections::BTreeMap;

use crate::geo::{Map, Power, SupplyCenter};
use crate::json::{MilaMessage, MilaPhase, SavedPledge, SavedRejection};
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
    /// Phases adjudicated by this instance, oldest first.
    pub history: Vec<PhaseRecord>,
    pub status: Status,
    /// Phases that came before `history`, kept exactly as they were recorded.
    /// A game restored from a snapshot trusts these instead of adjudicating them
    /// again, so an engine upgrade can never invalidate a game in flight.
    pub archive: Vec<MilaPhase>,
    /// Press, keyed by the phase it was sent in (`S1901M`).
    pub press: BTreeMap<String, Vec<MilaMessage>>,
    /// Pledges made during the game, with their receipts once issued.
    pub pledges: Vec<SavedPledge>,
    /// Orders a host set aside before adjudication, keyed by the phase they
    /// were sent for (`S1901M`). They never reach the resolver; they are kept
    /// so a saved game shows everything that was asked for.
    pub rejected: BTreeMap<String, Vec<SavedRejection>>,
    /// The powers sharing a draw. Empty unless `status` is [`Status::Draw`].
    pub draw_members: Vec<Power>,
    /// Version of the engine that started the record.
    pub recorded_by: String,
}

impl Game {
    pub fn new(map: &'static Map, rulebook: Rulebook) -> Game {
        let rulebook = map.rulebook_overrides.apply(rulebook);
        Game {
            map,
            rulebook,
            state: GameState::initial(map),
            history: Vec::new(),
            status: Status::Active,
            archive: Vec::new(),
            press: BTreeMap::new(),
            pledges: Vec::new(),
            rejected: BTreeMap::new(),
            draw_members: Vec::new(),
            recorded_by: crate::VERSION.to_string(),
        }
    }

    /// Start from an arbitrary state (for replays, sandboxes and tests).
    pub fn from_state(map: &'static Map, rulebook: Rulebook, state: GameState) -> Game {
        let rulebook = map.rulebook_overrides.apply(rulebook);
        Game {
            map,
            rulebook,
            state,
            history: Vec::new(),
            status: Status::Active,
            archive: Vec::new(),
            press: BTreeMap::new(),
            pledges: Vec::new(),
            rejected: BTreeMap::new(),
            draw_members: Vec::new(),
            recorded_by: crate::VERSION.to_string(),
        }
    }

    pub fn map(&self) -> &'static Map {
        self.map
    }

    pub fn phase(&self) -> Phase {
        self.state.phase
    }

    /// The current state as `power` may see it: filtered by
    /// [`GameState::visible_to`] when the rulebook enables fog of war,
    /// otherwise the full board.
    pub fn view_for(&self, power: Power) -> GameState {
        if self.rulebook.fog_of_war {
            self.state.visible_to(self.map, power)
        } else {
            self.state.clone()
        }
    }

    pub fn is_finished(&self) -> bool {
        self.status != Status::Active
    }

    /// Process the current phase with orders of any kind; orders for other phase kinds are ignored.
    pub fn process(&mut self, orders: &[AnyOrder]) -> Result<&PhaseResult, GameError> {
        if self.is_finished() {
            return Err(GameError::Finished);
        }
        // Only a state made by hand can stand at the calendar's last adjustment: there is no
        // spring after it to play, so the game ends there.
        if self.end_of_calendar() {
            self.declare_draw();
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
        if result.dislodged.is_empty() {
            // Standoffs only matter to retreats; with nobody dislodged the next
            // state carries none, which keeps a state a pure function of the board.
            self.state = next;
            self.after_retreats();
        } else {
            next.dislodged = result.dislodged.clone();
            next.standoffs = result.standoffs.clone();
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
        // `process` never adjudicates the last year's adjustments, so this is a year that exists.
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
                if phase.year >= Phase::LAST_YEAR {
                    // The calendar has run out: nobody won, so everyone still standing shares it.
                    self.state.phase =
                        Phase::new(phase.year, Season::Winter, PhaseKind::Adjustment);
                    self.declare_draw();
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

    /// The power holding the most centres, when that reaches the victory threshold.
    /// Lower power ids win ties, which only small variant maps can produce.
    pub(crate) fn solo_winner(&self) -> Option<Power> {
        self.map
            .power_ids()
            .map(|p| (self.state.position.count_centers(p), p))
            .filter(|&(n, _)| n >= self.rulebook.victory_centers as usize)
            .max_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)))
            .map(|(_, p)| p)
    }

    /// True for an adjustment phase in the calendar's last year, which has no spring to follow.
    pub(crate) fn end_of_calendar(&self) -> bool {
        self.state.phase.kind == PhaseKind::Adjustment && self.state.phase.year >= Phase::LAST_YEAR
    }

    /// End the game by agreement, shared by every power still on the board.
    pub fn declare_draw(&mut self) {
        let survivors: Vec<Power> = {
            let out = self.eliminated();
            self.map.power_ids().filter(|p| !out.contains(p)).collect()
        };
        self.declare_draw_among(&survivors);
    }

    /// End the game by agreement among `members`. No effect on a finished game.
    pub fn declare_draw_among(&mut self, members: &[Power]) {
        if self.status == Status::Active {
            self.status = Status::Draw;
            let mut members = members.to_vec();
            members.sort();
            members.dedup();
            self.draw_members = members;
        }
    }

    /// Number of adjudicated phases, archived ones included.
    pub fn phase_count(&self) -> usize {
        self.archive.len() + self.history.len()
    }

    /// Attach a press message to the current phase. An empty `phase` is filled in.
    pub fn record_message(&mut self, mut message: MilaMessage) {
        let phase = self.state.phase.to_string();
        if message.phase.is_empty() {
            message.phase = phase.clone();
        }
        self.press.entry(phase).or_default().push(message);
    }

    /// Keep the orders that were set aside for `phase` before it was
    /// adjudicated. Replaces what was kept for that phase; an empty list
    /// removes the entry.
    pub fn record_rejected(&mut self, phase: Phase, rejected: Vec<SavedRejection>) {
        if rejected.is_empty() {
            self.rejected.remove(&phase.to_string());
        } else {
            self.rejected.insert(phase.to_string(), rejected);
        }
    }

    /// The orders set aside for adjudicated phase `index`, archived phases
    /// counted first. Empty when there were none or the index is out of range.
    pub fn rejected_at(&self, index: usize) -> &[SavedRejection] {
        let name = match index.checked_sub(self.archive.len()) {
            None => Some(self.archive[index].state.name.clone()),
            Some(i) => self.history.get(i).map(|r| r.state.phase.to_string()),
        };
        name.and_then(|n| self.rejected.get(&n))
            .map_or(&[], Vec::as_slice)
    }

    /// Record a pledge, or replace the one with the same non-empty id (for
    /// example to add its receipt once the phase is adjudicated).
    pub fn record_pledge(&mut self, pledge: SavedPledge) {
        match self
            .pledges
            .iter_mut()
            .find(|p| !pledge.id.is_empty() && p.id == pledge.id)
        {
            Some(existing) => *existing = pledge,
            None => self.pledges.push(pledge),
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
    #[test]
    fn view_for_hides_the_board_only_under_fog_of_war() {
        let map = Map::standard();
        let france = map.find_power("FRA").unwrap();
        let open = Game::new(map, Rulebook::default());
        assert_eq!(open.view_for(france), open.state);

        let fog = Game::new(
            map,
            Rulebook {
                fog_of_war: true,
                ..Rulebook::default()
            },
        );
        let view = fog.view_for(france);
        assert!(view.position.units.len() < fog.state.position.units.len());
        assert!(view.position.units.iter().any(|u| u.power == france));
    }

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
