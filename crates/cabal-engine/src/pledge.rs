//! Seals: cryptographic commitments to orders, and their receipts.
//!
//! A *seal* is a BLAKE3 commitment over a canonical order list plus a nonce.
//! After adjudication the pledged orders are compared with what the pledger
//! actually submitted and a *receipt* (`Kept`, `Broken`, `Void`) is issued.
//! Everything here is pure, so any client can recompute a receipt from a replay.
//!
//! Two layers. [`commit`], [`opens`] and [`receipt`] work on text alone.
//! [`check`] and [`receipt_for`] also look at the board: a pledge must be a
//! legal order for a unit the pledger commands, and silence from a power that
//! had something to order breaks a pledge instead of voiding it.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::geo::{Map, Power};
use crate::order::{AdjustCommand, AnyOrder};
use crate::outcome::Illegal;
use crate::state::{GameState, PhaseKind};
use crate::text::{adjust_text, order_text, retreat_text_in};

/// Canonical form: trimmed, upper-cased, single-spaced, sorted, de-duplicated, newline joined.
pub fn canonical(orders: &[String]) -> String {
    let mut v: Vec<String> = orders
        .iter()
        .map(|o| {
            o.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_ascii_uppercase()
        })
        .filter(|o| !o.is_empty())
        .collect();
    v.sort();
    v.dedup();
    v.join("\n")
}

/// Hex BLAKE3 of `canonical(orders) || 0x00 || nonce`.
pub fn commit(orders: &[String], nonce: &[u8]) -> String {
    let mut h = blake3::Hasher::new();
    h.update(canonical(orders).as_bytes());
    h.update(&[0]);
    h.update(nonce);
    hex::encode(h.finalize().as_bytes())
}

/// Does a revealed order list plus nonce match a commitment?
pub fn opens(commitment: &str, orders: &[String], nonce: &[u8]) -> bool {
    commit(orders, nonce).eq_ignore_ascii_case(commitment)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Receipt {
    /// Every pledged order was submitted.
    Kept,
    /// At least one pledged order was not submitted.
    Broken,
    /// The pledger had no orders in that phase (eliminated, or phase skipped).
    Void,
}

/// Compare pledged orders with the orders actually submitted in that phase,
/// on text alone. An empty submission is `Void` here because text cannot tell a
/// power with nothing to order from one that stayed silent; hosts that have the
/// board should call [`receipt_for`], which can.
pub fn receipt(pledged: &[String], submitted: &[String]) -> Receipt {
    if submitted.is_empty() {
        return Receipt::Void;
    }
    let have = canonical(submitted);
    let have: std::collections::HashSet<&str> = have.lines().collect();
    let want = canonical(pledged);
    if want.lines().all(|l| have.contains(l)) {
        Receipt::Kept
    } else {
        Receipt::Broken
    }
}

/// Why a pledge cannot be made.
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
pub enum PledgeError {
    #[error("a pledge needs at least one order")]
    Empty,
    #[error("{order}: {reason}")]
    Unreadable { order: String, reason: String },
    #[error("{order}: there is no unit there to pledge")]
    NoSuchUnit { order: String },
    #[error("{order}: you can only pledge orders for your own units")]
    NotYourUnit { order: String },
    #[error("{order}: not a legal order ({reason:?})")]
    IllegalOrder { order: String, reason: Illegal },
    #[error("{order}: not possible in this phase")]
    NotPossible { order: String },
}

/// Canonical text of one order as `power` would give it in `state`, checked
/// against the board. Movement orders must be legal; retreats must be among the
/// unit's options; builds and disbands must concern the power's own centres
/// and units.
fn board_order(
    map: &Map,
    state: &GameState,
    power: Power,
    text: &str,
) -> Result<String, PledgeError> {
    let order = || text.trim().to_string();
    let unreadable = |e: crate::parse::ParseError| PledgeError::Unreadable {
        order: order(),
        reason: e.to_string(),
    };
    let parsed = crate::parse::parse(map, text).map_err(unreadable)?;
    if parsed.power.is_some_and(|named| named != power) {
        return Err(PledgeError::NotYourUnit { order: order() });
    }
    let pos = &state.position;
    match state.phase.kind {
        PhaseKind::Movement => {
            let o = parsed.to_movement(Some(power)).map_err(unreadable)?;
            match crate::order::normalise(map, pos, o) {
                Ok(o) => Ok(order_text(map, pos, &o)),
                Err(Illegal::NoUnit) => Err(PledgeError::NoSuchUnit { order: order() }),
                Err(Illegal::ForeignUnit) => Err(PledgeError::NotYourUnit { order: order() }),
                Err(reason) => Err(PledgeError::IllegalOrder {
                    order: order(),
                    reason,
                }),
            }
        }
        PhaseKind::Retreat => {
            let o = parsed.to_retreat(Some(power)).map_err(unreadable)?;
            let Some(d) = state.dislodged.iter().find(|d| d.unit.province() == o.unit) else {
                return Err(PledgeError::NoSuchUnit { order: order() });
            };
            if d.unit.power != power {
                return Err(PledgeError::NotYourUnit { order: order() });
            }
            let options = crate::legal::legal_retreats(map, state, power);
            let wanted = retreat_text_in(map, state, &o);
            let legal = options
                .get(&o.unit)
                .into_iter()
                .flatten()
                .any(|l| retreat_text_in(map, state, l) == wanted);
            if legal {
                Ok(wanted)
            } else {
                Err(PledgeError::NotPossible { order: order() })
            }
        }
        PhaseKind::Adjustment => {
            let o = parsed.to_adjustment(Some(power)).map_err(unreadable)?;
            let delta = crate::adjudicate::adjustment::allowance(pos, power);
            let ok = match o.command {
                AdjustCommand::Build { region, .. } => {
                    if pos.owners.get(&region.province) != Some(&power) {
                        return Err(PledgeError::NotYourUnit { order: order() });
                    }
                    delta > 0
                }
                AdjustCommand::Disband { unit } => match pos.unit_at(unit) {
                    None => return Err(PledgeError::NoSuchUnit { order: order() }),
                    Some(u) if u.power != power => {
                        return Err(PledgeError::NotYourUnit { order: order() });
                    }
                    Some(_) => delta < 0,
                },
                AdjustCommand::Waive => delta > 0,
            };
            if ok {
                Ok(adjust_text(map, pos, &o))
            } else {
                Err(PledgeError::NotPossible { order: order() })
            }
        }
    }
}

/// Validate a pledge when it is made and return its orders in canonical text.
///
/// Rejected: an empty pledge, text that does not parse, an order for a unit
/// that is not there or belongs to someone else, and an order the pledger could
/// not legally give. A pledge nobody could keep is a lie with a receipt.
pub fn check(
    map: &Map,
    state: &GameState,
    power: Power,
    orders: &[String],
) -> Result<Vec<String>, PledgeError> {
    let mut out: Vec<String> = Vec::new();
    for text in orders.iter().filter(|o| !o.trim().is_empty()) {
        let order = board_order(map, state, power, text)?;
        if !out.contains(&order) {
            out.push(order);
        }
    }
    if out.is_empty() {
        return Err(PledgeError::Empty);
    }
    Ok(out)
}

/// The receipt for a pledge, judged against the board the phase started from.
///
/// - `Void`: the pledge never bound anything. Either it names no valid order
///   for a unit of the pledger (which [`check`] would have rejected), or the
///   pledger had nothing to order in that phase.
/// - `Broken`: a pledged order is missing from what was submitted. Submitting
///   nothing at all while having units to order is the plainest case.
/// - `Kept`: every pledged order was submitted.
///
/// Both sides are canonicalised against the board first, so `par - bur`,
/// `A PAR - BUR` and `FRA: A PAR - BUR` are the same order.
pub fn receipt_for(
    map: &Map,
    state: &GameState,
    power: Power,
    pledged: &[String],
    submitted: &[String],
) -> Receipt {
    let Ok(want) = check(map, state, power, pledged) else {
        return Receipt::Void;
    };
    let have: BTreeSet<String> = submitted
        .iter()
        .map(|text| {
            // An order that fails the board check was still submitted: compare its text.
            board_order(map, state, power, text).unwrap_or_else(|_| loose(map, state, power, text))
        })
        .collect();
    if want.iter().all(|o| have.contains(o)) {
        Receipt::Kept
    } else {
        Receipt::Broken
    }
}

/// Canonical text without the legality check, falling back to tidied input.
fn loose(map: &Map, state: &GameState, power: Power, text: &str) -> String {
    let pos = &state.position;
    let typed = crate::parse::parse(map, text)
        .ok()
        .and_then(|p| match state.phase.kind {
            PhaseKind::Movement => p.to_movement(Some(power)).ok().map(AnyOrder::Movement),
            PhaseKind::Retreat => p.to_retreat(Some(power)).ok().map(AnyOrder::Retreat),
            PhaseKind::Adjustment => p.to_adjustment(Some(power)).ok().map(AnyOrder::Adjustment),
        });
    match typed {
        Some(AnyOrder::Movement(o)) => order_text(map, pos, &o),
        Some(AnyOrder::Retreat(o)) => retreat_text_in(map, state, &o),
        Some(AnyOrder::Adjustment(o)) => adjust_text(map, pos, &o),
        None => canonical(&[text.to_string()]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn canonical_is_order_and_case_insensitive() {
        assert_eq!(
            canonical(&s(&["a par - bur", "F  BRE  H"])),
            canonical(&s(&["F BRE H", "A PAR - BUR"]))
        );
    }

    #[test]
    fn commitment_opens_only_with_same_inputs() {
        let orders = s(&["A MUN S F KIE - DEN"]);
        let c = commit(&orders, b"nonce");
        assert!(opens(&c, &s(&["a mun s f kie - den"]), b"nonce"));
        assert!(!opens(&c, &orders, b"other"));
        assert!(!opens(&c, &s(&["A MUN H"]), b"nonce"));
    }

    #[test]
    fn receipts() {
        let pledged = s(&["A MUN S F KIE - DEN"]);
        assert_eq!(
            receipt(&pledged, &s(&["F KIE - DEN", "A MUN S F KIE - DEN"])),
            Receipt::Kept
        );
        assert_eq!(
            receipt(&pledged, &s(&["F KIE - DEN", "A MUN - BUR"])),
            Receipt::Broken
        );
        assert_eq!(receipt(&pledged, &[]), Receipt::Void);
    }

    fn board() -> (&'static Map, GameState, Power) {
        let map = Map::standard();
        (
            map,
            GameState::initial(map),
            map.find_power("FRANCE").unwrap(),
        )
    }

    #[test]
    fn silence_from_a_power_with_units_breaks_the_pledge() {
        let (map, state, france) = board();
        let pledged = s(&["A PAR - BUR"]);
        assert_eq!(
            receipt_for(map, &state, france, &pledged, &[]),
            Receipt::Broken
        );
        // the text-only comparison cannot know and still says void
        assert_eq!(receipt(&pledged, &[]), Receipt::Void);
    }

    #[test]
    fn a_power_with_nothing_to_order_gets_void() {
        let (map, mut state, france) = board();
        state.position.units.retain(|u| u.power != france);
        assert_eq!(
            receipt_for(map, &state, france, &s(&["A PAR - BUR"]), &[]),
            Receipt::Void
        );
        assert_eq!(receipt_for(map, &state, france, &[], &[]), Receipt::Void);
    }

    #[test]
    fn pledging_another_powers_unit_is_rejected() {
        let (map, state, france) = board();
        assert_eq!(
            check(map, &state, france, &s(&["A MUN - BUR"])),
            Err(PledgeError::NotYourUnit {
                order: "A MUN - BUR".into()
            })
        );
        assert_eq!(
            check(map, &state, france, &s(&["GER: A MUN - BUR"])),
            Err(PledgeError::NotYourUnit {
                order: "GER: A MUN - BUR".into()
            })
        );
        assert_eq!(
            check(map, &state, france, &s(&["A BUR - MUN"])),
            Err(PledgeError::NoSuchUnit {
                order: "A BUR - MUN".into()
            })
        );
        assert!(matches!(
            check(map, &state, france, &s(&["A PAR - MOS"])),
            Err(PledgeError::IllegalOrder { .. })
        ));
        assert_eq!(check(map, &state, france, &[]), Err(PledgeError::Empty));
        // and if such a pledge reaches adjudication anyway, it binds nothing
        assert_eq!(
            receipt_for(
                map,
                &state,
                france,
                &s(&["A MUN - BUR"]),
                &s(&["A PAR - BUR"])
            ),
            Receipt::Void
        );
    }

    #[test]
    fn board_receipts_compare_canonical_orders() {
        let (map, state, france) = board();
        assert_eq!(
            check(map, &state, france, &s(&["par - bur", "FRA: A PAR - BUR"])),
            Ok(s(&["A PAR - BUR"]))
        );
        let pledged = s(&["A PAR - BUR", "A MAR S A PAR - BUR"]);
        assert_eq!(
            receipt_for(
                map,
                &state,
                france,
                &pledged,
                &s(&["par - bur", "a mar s par - bur", "F BRE - MAO"])
            ),
            Receipt::Kept
        );
        assert_eq!(
            receipt_for(map, &state, france, &pledged, &s(&["A PAR - BUR"])),
            Receipt::Broken
        );
        assert_eq!(
            receipt_for(map, &state, france, &pledged, &s(&["A PAR H", "A MAR H"])),
            Receipt::Broken
        );
    }

    #[test]
    fn retreat_and_adjustment_pledges_are_checked_against_the_board() {
        use crate::state::{Dislodged, Phase, Season};
        let (map, mut state, france) = board();
        let paris = map.find_province("par").unwrap();
        let unit = state.position.remove_unit_at(paris).unwrap();
        state.phase = Phase::new(1901, Season::Spring, PhaseKind::Retreat);
        state.dislodged.push(Dislodged {
            unit,
            attacker_from: map.find_province("bur").unwrap(),
            by_convoy: false,
        });
        assert_eq!(
            check(map, &state, france, &s(&["A PAR R PIC"])),
            Ok(s(&["A PAR R PIC"]))
        );
        assert!(matches!(
            check(map, &state, france, &s(&["A PAR R BUR"])),
            Err(PledgeError::NotPossible { .. })
        ));
        let germany = map.find_power("GERMANY").unwrap();
        assert!(matches!(
            check(map, &state, germany, &s(&["A PAR R PIC"])),
            Err(PledgeError::NotYourUnit { .. })
        ));
        assert_eq!(
            receipt_for(map, &state, france, &s(&["A PAR R PIC"]), &[]),
            Receipt::Broken
        );

        let mut winter = GameState::initial(map);
        winter.phase = Phase::new(1901, Season::Winter, PhaseKind::Adjustment);
        winter.position.remove_unit_at(paris);
        assert!(check(map, &winter, france, &s(&["A PAR B"])).is_ok());
        assert!(matches!(
            check(map, &winter, france, &s(&["A MUN B"])),
            Err(PledgeError::NotYourUnit { .. })
        ));
        assert!(matches!(
            check(map, &winter, germany, &s(&["A MUN B"])),
            Err(PledgeError::NotPossible { .. })
        ));
    }
}
