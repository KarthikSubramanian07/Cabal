//! Lossless snapshots: restore a game without adjudicating its past.
//!
//! A host that persists a game has two things to keep: where the game stands
//! now, and how it got there. [`Snapshot`] is the first, in constant size: the
//! current state with everything a retreat phase needs, the rulebook, the
//! outcome and a count of the phases already adjudicated. The saved game is the
//! second, and it only ever grows by appending.
//!
//! [`Game::from_snapshot`] puts the two back together. Phases the snapshot
//! already covers are taken from the saved game verbatim, as an archive. Phases
//! recorded after the snapshot was taken (the tail, at most a phase or two when
//! a host writes the snapshot less often than the save) are adjudicated from the
//! snapshot's state. Nothing before the snapshot is ever adjudicated again, so a
//! corrected ruling in a newer engine cannot make an old game unloadable.
//!
//! Checking that a record still reproduces is a separate, explicit operation:
//! [`Game::verify_saved`].

use serde::{Deserialize, Serialize};

use crate::game::Game;
use crate::geo::Map;
use crate::json::{
    ImportError, MilaMessage, MilaState, ReplayError, SavedGame, SavedOutcome, SavedPledge,
    recorded_orders, same_holdings, state_from_mila, state_to_mila_with,
};
use crate::rulebook::Rulebook;

/// The snapshot layout this engine writes.
pub const SNAPSHOT_FORMAT: u32 = 1;

/// Where a game stands, losslessly and without its history.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    /// Layout version; readers reject versions they do not know.
    pub format: u32,
    /// Version of the engine that wrote the snapshot.
    pub engine: String,
    pub map: String,
    pub rulebook: Rulebook,
    pub outcome: SavedOutcome,
    /// How many phases had been adjudicated when the snapshot was taken.
    pub adjudicated: usize,
    /// Current state in MILA layout, with Cabal's retreat extras.
    pub state: MilaState,
    /// Press sent so far in the current phase.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub messages: Vec<MilaMessage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pledges: Vec<SavedPledge>,
    /// Version of the engine that started the record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorded_by: Option<String>,
}

impl Game {
    /// Capture the current state. Constant size: no history is included.
    pub fn snapshot(&self) -> Snapshot {
        let state = state_to_mila_with(self.map(), &self.state, self.rulebook);
        Snapshot {
            format: SNAPSHOT_FORMAT,
            engine: crate::VERSION.to_string(),
            map: self.map().name.clone(),
            rulebook: self.rulebook,
            outcome: self.saved_outcome(),
            adjudicated: self.phase_count(),
            messages: self.press.get(&state.name).cloned().unwrap_or_default(),
            state,
            pledges: self.pledges.clone(),
            recorded_by: Some(self.recorded_by.clone()),
        }
    }

    /// Restore from a snapshot, optionally with the saved game as its history.
    ///
    /// With `history`, the phases the snapshot covers are archived verbatim and
    /// any later ones are adjudicated from the snapshot's state. Tail orders that
    /// no longer parse are skipped (the unit holds) instead of failing the
    /// restore. If the save is behind the snapshot, the snapshot still wins and
    /// the phases the save lacks are simply absent from later exports.
    ///
    /// The save has to be this snapshot's history: the same map, and at the
    /// point the snapshot was taken the same phase with the same units and
    /// centres. Anything else is [`ReplayError::SnapshotMismatch`] rather than
    /// another game's past spliced onto this one and its later orders
    /// adjudicated on the wrong board. A save that ends before the snapshot
    /// has no such point and is accepted on its map alone.
    ///
    /// Without `history` the game continues from the snapshot with an empty
    /// record.
    pub fn from_snapshot(
        snapshot: &Snapshot,
        history: Option<&SavedGame>,
    ) -> Result<Game, ReplayError> {
        if snapshot.format != SNAPSHOT_FORMAT {
            return Err(ReplayError::SnapshotFormat(snapshot.format));
        }
        let map = Map::by_name(&snapshot.map)
            .ok_or_else(|| ImportError::UnknownMap(snapshot.map.clone()))?;
        let state = state_from_mila(map, &snapshot.state)?;
        let mut game = Game::from_state(map, snapshot.rulebook, state);
        game.pledges = snapshot.pledges.clone();
        if let Some(v) = &snapshot.recorded_by {
            game.recorded_by = v.clone();
        }
        if !snapshot.messages.is_empty() {
            game.press
                .insert(snapshot.state.name.clone(), snapshot.messages.clone());
        }
        if let Some(saved) = history {
            if !saved.map.eq_ignore_ascii_case(&snapshot.map) {
                return Err(ReplayError::SnapshotMismatch(format!(
                    "it was played on {}, the snapshot on {}",
                    saved.map, snapshot.map
                )));
            }
            if let Some(join) = saved.phases.get(snapshot.adjudicated) {
                let (theirs, ours) = (&join.state, &snapshot.state);
                if !theirs.name.eq_ignore_ascii_case(&ours.name) {
                    return Err(ReplayError::SnapshotMismatch(format!(
                        "phase {} of it is {}, the snapshot was taken in {}",
                        snapshot.adjudicated, theirs.name, ours.name
                    )));
                }
                if !same_holdings(&theirs.units, &ours.units)
                    || !same_holdings(&theirs.centers, &ours.centers)
                {
                    return Err(ReplayError::SnapshotMismatch(format!(
                        "its board in {} is not the snapshot's",
                        ours.name
                    )));
                }
            }
        }
        // what was set aside for past phases lives in the save, not the snapshot
        if let Some(meta) = history.and_then(|saved| saved.cabal.as_ref()) {
            game.rejected = meta.rejected.clone();
        }
        // every phase of the save but its last (the unplayed one) was adjudicated
        let recorded = history.map_or(&[][..], |saved| match saved.phases.split_last() {
            Some((_, earlier)) => earlier,
            None => &[],
        });
        let covered = snapshot.adjudicated.min(recorded.len());
        game.archive = recorded[..covered].to_vec();
        let tail = &recorded[covered..];
        if tail.is_empty() || snapshot.adjudicated > recorded.len() {
            game.adopt_recorded_status(Some(&snapshot.outcome), false)?;
            return Ok(game);
        }
        let saved = history.expect("a tail implies a save");
        for phase in tail {
            if !phase.messages.is_empty() {
                game.press
                    .insert(phase.state.name.clone(), phase.messages.clone());
            }
            let (typed, _unreadable) = recorded_orders(map, game.phase().kind, &phase.orders)?;
            if game.process(&typed).is_err() {
                break;
            }
        }
        if let Some(last) = saved.phases.last() {
            if !last.messages.is_empty() {
                game.press
                    .insert(last.state.name.clone(), last.messages.clone());
            }
        }
        if let Some(meta) = &saved.cabal {
            if meta.pledges.len() >= game.pledges.len() {
                game.pledges = meta.pledges.clone();
            }
        }
        game.adopt_outcome(saved)?;
        Ok(game)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::order::Order;
    use crate::parse::parse;
    use crate::state::PhaseKind;

    fn movement(map: &Map, lines: &[&str]) -> Vec<Order> {
        lines
            .iter()
            .map(|l| parse(map, l).unwrap().to_movement(None).unwrap())
            .collect()
    }

    #[test]
    fn snapshot_round_trips_a_retreat_phase_exactly() {
        let map = Map::standard();
        let mut g = Game::new(map, Rulebook::default());
        g.process_movement(&movement(map, &["FRA: A PAR - BUR", "GER: A MUN - RUH"]));
        g.process_movement(&movement(
            map,
            &[
                "FRA: A BUR - MUN",
                "GER: A RUH - MUN",
                "GER: A BER - SIL",
                "RUS: A WAR - SIL",
            ],
        ));
        // the next year: Burgundy takes Munich with support while Silesia bounces again
        if g.phase().kind == PhaseKind::Adjustment {
            g.process_adjustment(&[]);
        }
        g.process_movement(&movement(
            map,
            &[
                "GER: A RUH - MUN",
                "FRA: A BUR - RUH",
                "FRA: A MAR - BUR",
                "GER: A BER - SIL",
                "RUS: A WAR - SIL",
            ],
        ));
        g.process_movement(&movement(
            map,
            &[
                "FRA: A BUR - MUN",
                "FRA: A RUH S A BUR - MUN",
                "GER: A BER - SIL",
                "RUS: A WAR - SIL",
            ],
        ));
        assert_eq!(g.phase().kind, PhaseKind::Retreat, "{}", g.phase());
        assert!(!g.state.standoffs.is_empty());

        let json = serde_json::to_string(&g.snapshot()).unwrap();
        let snapshot: Snapshot = serde_json::from_str(&json).unwrap();
        let restored = Game::from_snapshot(&snapshot, None).unwrap();
        assert_eq!(restored.state, g.state);
        assert_eq!(restored.status, g.status);
        assert_eq!(restored.rulebook, g.rulebook);

        // with the save as history the export is the same file again
        let saved = g.to_saved("x");
        let restored = Game::from_snapshot(&snapshot, Some(&saved)).unwrap();
        assert_eq!(restored.state, g.state);
        assert_eq!(restored.phase_count(), g.phase_count());
        assert!(restored.history.is_empty(), "nothing was adjudicated");
        assert_eq!(restored.to_saved("x"), saved);
    }

    #[test]
    fn a_tail_recorded_after_the_snapshot_is_replayed() {
        let map = Map::standard();
        let mut g = Game::new(map, Rulebook::default());
        g.process_movement(&movement(map, &["FRA: A PAR - BUR"]));
        let snapshot = g.snapshot();
        g.process_movement(&movement(map, &["FRA: A BUR - BEL"]));
        let saved = g.to_saved("x");

        let restored = Game::from_snapshot(&snapshot, Some(&saved)).unwrap();
        assert_eq!(restored.archive.len(), 1);
        assert_eq!(restored.history.len(), 1, "only the tail is adjudicated");
        assert_eq!(restored.state, g.state);
        assert_eq!(restored.to_saved("x"), saved);
    }

    #[test]
    fn a_snapshot_ahead_of_the_save_still_restores() {
        let map = Map::standard();
        let mut g = Game::new(map, Rulebook::default());
        g.process_movement(&movement(map, &["FRA: A PAR - BUR"]));
        let stale = g.to_saved("x");
        g.process_movement(&movement(map, &["FRA: A BUR - BEL"]));
        let snapshot = g.snapshot();

        let restored = Game::from_snapshot(&snapshot, Some(&stale)).unwrap();
        assert_eq!(restored.state, g.state);
        assert_eq!(restored.archive.len(), 1);
    }

    #[test]
    fn unknown_snapshot_formats_are_refused() {
        let mut snapshot = Game::new(Map::standard(), Rulebook::default()).snapshot();
        snapshot.format = 99;
        assert_eq!(
            Game::from_snapshot(&snapshot, None).unwrap_err(),
            ReplayError::SnapshotFormat(99)
        );
    }

    #[test]
    fn a_snapshot_with_an_ending_from_a_newer_engine_still_restores() {
        let map = Map::standard();
        let mut g = Game::new(map, Rulebook::default());
        g.process_movement(&movement(map, &["FRA: A PAR - BUR"]));
        let mut json = serde_json::to_value(g.snapshot()).unwrap();
        json["outcome"] = serde_json::json!({ "result": "abandoned", "by": "host" });
        let snapshot: Snapshot = serde_json::from_value(json).unwrap();
        assert_eq!(snapshot.outcome, SavedOutcome::Unknown);
        let restored = Game::from_snapshot(&snapshot, None).unwrap();
        assert_eq!(restored.state, g.state);
        assert!(!restored.is_finished());
    }

    #[test]
    fn a_save_that_is_not_the_snapshots_history_is_refused() {
        let map = Map::standard();
        let mut g = Game::new(map, Rulebook::default());
        g.process_movement(&movement(map, &["FRA: A PAR - BUR"]));
        let snapshot = g.snapshot();
        g.process_movement(&movement(map, &["FRA: A BUR - BEL"]));
        let mismatch = |saved: &SavedGame| match Game::from_snapshot(&snapshot, Some(saved)) {
            Err(ReplayError::SnapshotMismatch(why)) => why,
            other => panic!("expected a mismatch, got {:?}", other.map(|g| g.state)),
        };

        // another game that reached the same phase by other orders: its tail
        // would be adjudicated on a board those orders were never given for
        let mut other = Game::new(map, Rulebook::default());
        other.process_movement(&movement(map, &["FRA: A PAR - PIC", "GER: A MUN - BUR"]));
        other.process_movement(&movement(map, &["FRA: A PIC - BEL"]));
        assert!(mismatch(&other.to_saved("other")).contains("board"));

        // a save whose phases do not line up with the snapshot's count
        let mut shifted = g.to_saved("x");
        shifted.phases.remove(0);
        assert!(mismatch(&shifted).contains("phase 1"));

        // a game on another map
        let duel = Game::new(Map::by_name("duel").unwrap(), Rulebook::default());
        assert!(mismatch(&duel.to_saved("duel")).contains("duel"));

        // its own save, and the snapshot alone, still restore
        let restored = Game::from_snapshot(&snapshot, Some(&g.to_saved("x"))).unwrap();
        assert_eq!(restored.state, g.state);
        assert!(Game::from_snapshot(&snapshot, None).is_ok());
    }

    #[test]
    fn a_drawn_game_stays_drawn() {
        let map = Map::standard();
        let mut g = Game::new(map, Rulebook::default());
        g.process_movement(&[]);
        g.declare_draw_among(&[
            map.find_power("FRANCE").unwrap(),
            map.find_power("ENGLAND").unwrap(),
        ]);
        let restored = Game::from_snapshot(&g.snapshot(), Some(&g.to_saved("x"))).unwrap();
        assert!(restored.is_finished());
        assert_eq!(restored.draw_members, g.draw_members);
        assert_eq!(restored.to_saved("x"), g.to_saved("x"));
    }
}
