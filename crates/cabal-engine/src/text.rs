//! Canonical MILA text for orders and units.

use crate::adjudicate::movement::{CycleKind, MovementExplanation, Opposition, SupportUse};
use crate::geo::{Map, ProvinceId, Region, UnitKind};
use crate::order::{
    AdjustCommand, AdjustOrder, Command, Order, RetreatCommand, RetreatOrder, Unit,
};
use crate::outcome::{ConvoyOutcome, HoldOutcome, MoveOutcome, OrderOutcome, SupportOutcome};
use crate::state::Position;

/// `A PAR` or `F STP/NC`.
pub fn unit_text(map: &Map, unit: &Unit) -> String {
    format!("{} {}", unit.kind.letter(), map.region_name(unit.region))
}

fn kind_at(position: &Position, p: crate::geo::ProvinceId) -> Option<UnitKind> {
    position.unit_at(p).map(|u| u.kind)
}

fn region_text(
    map: &Map,
    position: &Position,
    p: crate::geo::ProvinceId,
    coast: Option<crate::geo::Coast>,
) -> String {
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
        Command::Move {
            dest,
            coast,
            via_convoy,
        } => {
            let d = region_text(map, position, dest, coast);
            if via_convoy {
                format!("{me} - {d} VIA")
            } else {
                format!("{me} - {d}")
            }
        }
        Command::SupportHold { target } => format!("{me} S {}", unit_ref(map, position, target)),
        Command::SupportMove {
            target,
            dest,
            coast,
        } => {
            format!(
                "{me} S {} - {}",
                unit_ref(map, position, target),
                region_text(map, position, dest, coast)
            )
        }
        Command::Convoy { army, dest } => {
            format!(
                "{me} C {} - {}",
                unit_ref(map, position, army),
                map.region_name(Region::land(dest))
            )
        }
    }
}

/// [`order_text`] for many orders on one board. Unit and province names are
/// looked up and upper-cased once, and each order is then assembled from those
/// without formatting machinery: about five times faster per order, which is
/// most of the cost of listing every legal order on a crowded board.
pub struct OrderTexts {
    /// Per province: the unit standing there (`A PAR`), else the province (`PAR`).
    units: Vec<String>,
    /// Per province: its code (`PAR`).
    places: Vec<String>,
}

impl OrderTexts {
    pub fn new(map: &Map, position: &Position) -> Self {
        let places: Vec<String> = map
            .provinces()
            .iter()
            .map(|p| p.name.to_ascii_uppercase())
            .collect();
        let mut units = places.clone();
        for u in &position.units {
            units[u.province().0 as usize] = unit_text(map, u);
        }
        OrderTexts { units, places }
    }

    /// The code of a province (`PAR`).
    pub fn place(&self, p: ProvinceId) -> &str {
        &self.places[p.0 as usize]
    }

    /// The unit in a province in full (`A PAR`), or the province code when it is empty.
    pub fn unit(&self, p: ProvinceId) -> &str {
        &self.units[p.0 as usize]
    }

    fn push_region(&self, out: &mut String, p: ProvinceId, coast: Option<crate::geo::Coast>) {
        out.push_str(self.place(p));
        if let Some(c) = coast {
            out.push('/');
            out.push_str(c.code());
        }
    }

    /// A region as text (`STP/NC`).
    pub fn region(&self, r: Region) -> String {
        let mut out = String::with_capacity(6);
        self.push_region(&mut out, r.province, r.coast);
        out
    }

    /// Exactly [`order_text`] for the board this was built from.
    pub fn order(&self, order: &Order) -> String {
        let mut out = String::with_capacity(24);
        out.push_str(self.unit(order.unit));
        match order.command {
            Command::Hold => out.push_str(" H"),
            Command::Move {
                dest,
                coast,
                via_convoy,
            } => {
                out.push_str(" - ");
                self.push_region(&mut out, dest, coast);
                if via_convoy {
                    out.push_str(" VIA");
                }
            }
            Command::SupportHold { target } => {
                out.push_str(" S ");
                out.push_str(self.unit(target));
            }
            Command::SupportMove {
                target,
                dest,
                coast,
            } => {
                out.push_str(" S ");
                out.push_str(self.unit(target));
                out.push_str(" - ");
                self.push_region(&mut out, dest, coast);
            }
            Command::Convoy { army, dest } => {
                out.push_str(" C ");
                out.push_str(self.unit(army));
                out.push_str(" - ");
                out.push_str(self.place(dest));
            }
        }
        out
    }
}

/// Canonical retreat order text for a retreat phase state, e.g. `F BLA R SEV`
/// or `A BUL D`. The retreating unit is named in full: it is looked up among
/// the dislodged units, which are not on the board.
pub fn retreat_text_in(map: &Map, state: &crate::state::GameState, order: &RetreatOrder) -> String {
    let me = match state
        .dislodged
        .iter()
        .find(|d| d.unit.province() == order.unit)
    {
        Some(d) => unit_text(map, &d.unit),
        None => unit_ref(map, &state.position, order.unit),
    };
    retreat_text_of(map, me, order)
}

/// Retreat order text when only the board is known. A dislodged unit is not on
/// the board, so its kind is left out (`BLA R SEV`); prefer [`retreat_text_in`].
pub fn retreat_text(map: &Map, position: &Position, order: &RetreatOrder) -> String {
    let me = unit_ref(map, position, order.unit);
    retreat_text_of(map, me, order)
}

fn retreat_text_of(map: &Map, me: String, order: &RetreatOrder) -> String {
    match order.command {
        RetreatCommand::Retreat { dest, coast } => {
            format!("{me} R {}", map.region_name(Region::new(dest, coast)))
        }
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

/// One line, human readable explanation of a movement outcome. Other units are
/// named by province (`bounced with MUN`); with the board at hand prefer
/// [`describe_outcome_in`], which names them in full.
pub fn describe_outcome(map: &Map, out: &OrderOutcome) -> String {
    describe_with(out, &|p| map.province(p).name.to_ascii_uppercase())
}

/// [`describe_outcome`] naming every other unit in full (`bounced with A MUN`).
/// `position` is the board the phase started from.
pub fn describe_outcome_in(map: &Map, position: &Position, out: &OrderOutcome) -> String {
    describe_with(out, &|p| unit_ref(map, position, p))
}

fn describe_with(out: &OrderOutcome, name: &dyn Fn(ProvinceId) -> String) -> String {
    match out {
        OrderOutcome::Illegal {
            reason,
            dislodged_by,
        } => match dislodged_by {
            Some(by) => format!(
                "illegal order ({}), the unit holds and is dislodged by {}",
                reason.message(),
                name(*by)
            ),
            None => format!("illegal order ({}), the unit holds", reason.message()),
        },
        OrderOutcome::Hold(HoldOutcome::Holds) => "holds".into(),
        OrderOutcome::Hold(HoldOutcome::Dislodged { by }) => format!("dislodged by {}", name(*by)),
        OrderOutcome::Move(MoveOutcome::Succeeds) => "moves".into(),
        OrderOutcome::Move(MoveOutcome::NoPath) => "no convoy path".into(),
        OrderOutcome::Move(MoveOutcome::FriendlyFire) => "cannot dislodge own unit".into(),
        OrderOutcome::Move(MoveOutcome::LostHeadToHead { opponent }) => {
            format!("lost head-to-head with {}", name(*opponent))
        }
        OrderOutcome::Move(MoveOutcome::Repelled { occupant }) => {
            format!("repelled by {}", name(*occupant))
        }
        OrderOutcome::Move(MoveOutcome::Bounced { by }) => format!(
            "bounced with {}",
            by.iter().map(|&p| name(p)).collect::<Vec<_>>().join(", ")
        ),
        OrderOutcome::Support(SupportOutcome::Succeeds) => "support given".into(),
        OrderOutcome::Support(SupportOutcome::Cut { by }) => {
            format!("support cut by {}", name(*by))
        }
        OrderOutcome::Support(SupportOutcome::Dislodged { by }) => {
            format!("supporter dislodged by {}", name(*by))
        }
        OrderOutcome::Support(SupportOutcome::Void) => "support void (no matching order)".into(),
        OrderOutcome::Convoy(ConvoyOutcome::Succeeds) => "convoys".into(),
        OrderOutcome::Convoy(ConvoyOutcome::Dislodged { by }) => {
            format!("convoy dislodged by {}", name(*by))
        }
        OrderOutcome::Convoy(ConvoyOutcome::Paradox) => {
            "convoy fails (paradox, Szykman rule)".into()
        }
        OrderOutcome::Convoy(ConvoyOutcome::Void) => "convoy void (no matching move)".into(),
    }
}

/// Stable machine code for a movement outcome. Every way a move can fail has
/// its own code: `bounce` (beaten or tied by another move into the province),
/// `repelled` (could not beat the unit holding there), `head_to_head` (lost or
/// tied against the unit coming the other way), `own_unit` (would dislodge a
/// unit of its own power) and `no_path` (no unbroken convoy). The rest:
/// `ok`, `cut`, `void`, `dislodged`, `paradox`, `illegal`.
pub fn outcome_code(out: &OrderOutcome) -> &'static str {
    match out {
        OrderOutcome::Illegal { .. } => "illegal",
        OrderOutcome::Hold(HoldOutcome::Holds) => "ok",
        OrderOutcome::Hold(HoldOutcome::Dislodged { .. }) => "dislodged",
        OrderOutcome::Move(MoveOutcome::Succeeds) => "ok",
        OrderOutcome::Move(MoveOutcome::NoPath) => "no_path",
        OrderOutcome::Move(MoveOutcome::FriendlyFire) => "own_unit",
        OrderOutcome::Move(MoveOutcome::LostHeadToHead { .. }) => "head_to_head",
        OrderOutcome::Move(MoveOutcome::Repelled { .. }) => "repelled",
        OrderOutcome::Move(MoveOutcome::Bounced { .. }) => "bounce",
        OrderOutcome::Support(SupportOutcome::Succeeds) => "ok",
        OrderOutcome::Support(SupportOutcome::Cut { .. }) => "cut",
        OrderOutcome::Support(SupportOutcome::Dislodged { .. }) => "dislodged",
        OrderOutcome::Support(SupportOutcome::Void) => "void",
        OrderOutcome::Convoy(ConvoyOutcome::Succeeds) => "ok",
        OrderOutcome::Convoy(ConvoyOutcome::Dislodged { .. }) => "dislodged",
        OrderOutcome::Convoy(ConvoyOutcome::Paradox) => "paradox",
        OrderOutcome::Convoy(ConvoyOutcome::Void) => "void",
    }
}

/// The units an outcome names as its cause, by province: the units a move
/// bounced with, the occupant that repelled it, the head-to-head opponent, the
/// unit that cut a support or dislodged the unit. Empty for a success.
/// `order` is the adjudicated order the outcome belongs to.
pub fn outcome_actors(order: &Order, out: &OrderOutcome) -> Vec<ProvinceId> {
    match out {
        OrderOutcome::Illegal { dislodged_by, .. } => dislodged_by.iter().copied().collect(),
        OrderOutcome::Hold(HoldOutcome::Dislodged { by })
        | OrderOutcome::Support(SupportOutcome::Dislodged { by })
        | OrderOutcome::Support(SupportOutcome::Cut { by })
        | OrderOutcome::Convoy(ConvoyOutcome::Dislodged { by }) => vec![*by],
        OrderOutcome::Move(MoveOutcome::LostHeadToHead { opponent }) => vec![*opponent],
        OrderOutcome::Move(MoveOutcome::Repelled { occupant }) => vec![*occupant],
        OrderOutcome::Move(MoveOutcome::Bounced { by }) => by.clone(),
        OrderOutcome::Move(MoveOutcome::FriendlyFire) => match order.command {
            Command::Move { dest, .. } => vec![dest],
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

/// One plain-English sentence (sometimes two) saying why order `index` of a
/// movement phase resolved as it did, with every unit named in full and the
/// strengths that decided it. `position` is the board the phase started from;
/// `submitted` is the text of an order that was thrown out as illegal.
pub fn explain_sentence(
    map: &Map,
    position: &Position,
    explanation: &MovementExplanation,
    index: usize,
    submitted: Option<&str>,
) -> String {
    let order = &explanation.orders[index];
    let out = &explanation.outcomes[index];
    let why = &explanation.why[index];
    let unit = |p: ProvinceId| unit_ref(map, position, p);
    let me = unit(order.unit);
    let place = |p: ProvinceId| map.region_name(Region::land(p));
    let attack = why.attack.unwrap_or(0);
    let hold = why.hold.unwrap_or(1);

    // supports that did not count, and why
    let lost_support = |s: &SupportUse| -> Option<String> {
        let who = unit(s.supporter);
        match &s.outcome {
            SupportOutcome::Succeeds if !s.counted => Some(format!(
                "Support from {who} did not count: a unit never helps dislodge one of its own power."
            )),
            SupportOutcome::Cut { by } => {
                let cutters: Vec<String> = if s.cut_by.is_empty() {
                    vec![unit(*by)]
                } else {
                    s.cut_by.iter().map(|&c| unit(c)).collect()
                };
                Some(format!(
                    "Support from {who} was cut by an attack from {}.",
                    list(&cutters)
                ))
            }
            SupportOutcome::Dislodged { by } => Some(format!(
                "Support from {who} was lost when {} dislodged it.",
                unit(*by)
            )),
            _ => None,
        }
    };
    let counted: Vec<String> = why
        .supports
        .iter()
        .filter(|s| s.counted)
        .map(|s| unit(s.supporter))
        .collect();
    let with_support = if counted.is_empty() {
        String::new()
    } else {
        format!(" with support from {}", list(&counted))
    };

    let mut text = match out {
        OrderOutcome::Illegal {
            reason,
            dislodged_by,
        } => {
            let what = match submitted {
                Some(s) => format!("The order {s} is illegal"),
                None => format!("The order given to {me} is illegal"),
            };
            match dislodged_by {
                Some(by) => format!(
                    "{what}: {}. {me} held instead and was dislodged by {}.",
                    reason.message(),
                    unit(*by)
                ),
                None => format!("{what}: {}. {me} held instead.", reason.message()),
            }
        }
        OrderOutcome::Hold(HoldOutcome::Holds) => {
            let attackers: Vec<String> = why
                .attacks
                .iter()
                .map(|a| format!("{} (strength {})", unit(a.from), a.strength))
                .collect();
            if attackers.is_empty() {
                format!("{me} held.")
            } else {
                format!(
                    "{me} held with strength {hold}{with_support} against {}.",
                    list(&attackers)
                )
            }
        }
        OrderOutcome::Hold(HoldOutcome::Dislodged { by }) => {
            let strength = why
                .attacks
                .iter()
                .find(|a| a.from == *by)
                .map_or(0, |a| a.strength);
            format!(
                "{me} was dislodged by {}, which attacked with strength {strength} against a hold strength of {hold}.",
                unit(*by)
            )
        }
        OrderOutcome::Move(m) => {
            let dest = match order.command {
                Command::Move { dest, .. } => dest,
                _ => order.unit,
            };
            let to = place(dest);
            match m {
                MoveOutcome::Succeeds => {
                    let how = if why.by_convoy { " by convoy" } else { "" };
                    if counted.is_empty() {
                        format!("{me} moved to {to}{how}.")
                    } else {
                        format!("{me} moved to {to}{how} with strength {attack}{with_support}.")
                    }
                }
                MoveOutcome::NoPath => {
                    let paradox: Vec<String> = why
                        .convoys
                        .iter()
                        .filter(|c| c.outcome == ConvoyOutcome::Paradox)
                        .map(|c| unit(c.fleet))
                        .collect();
                    let sunk: Vec<String> = why
                        .convoys
                        .iter()
                        .filter_map(|c| match c.outcome {
                            ConvoyOutcome::Dislodged { by } => {
                                Some(format!("{} was dislodged by {}", unit(c.fleet), unit(by)))
                            }
                            _ => None,
                        })
                        .collect();
                    if why.convoys.is_empty() {
                        format!(
                            "{me} can only reach {to} by convoy, and no fleet was ordered to convoy it there."
                        )
                    } else if !paradox.is_empty() {
                        format!(
                            "The convoy carrying {me} to {to} failed: {} was caught in a convoy paradox, which the Szykman rule settles by failing the convoy.",
                            list(&paradox)
                        )
                    } else if !sunk.is_empty() {
                        format!(
                            "The convoy carrying {me} to {to} was broken: {}.",
                            list(&sunk)
                        )
                    } else {
                        format!(
                            "The fleets ordered to convoy {me} to {to} do not form an unbroken chain."
                        )
                    }
                }
                MoveOutcome::FriendlyFire => format!(
                    "{me} could not enter {to}: {} belongs to the same power and stayed there, and a power cannot dislodge its own unit.",
                    unit(dest)
                ),
                MoveOutcome::LostHeadToHead { opponent } => {
                    let defend = match why.opposition {
                        Some(Opposition::HeadToHead { strength, .. }) => strength,
                        _ => 0,
                    };
                    format!(
                        "{me} and {} moved into each other: strength {attack}{with_support} against {defend}, and a head-to-head is only won by the stronger side.",
                        unit(*opponent)
                    )
                }
                MoveOutcome::Repelled { occupant } => {
                    let strength = match why.opposition {
                        Some(Opposition::Hold { strength, .. }) => strength,
                        _ => 1,
                    };
                    format!(
                        "{me} attacked {to} with strength {attack}{with_support}, not enough to dislodge {}, which held with strength {strength}.",
                        unit(*occupant)
                    )
                }
                MoveOutcome::Bounced { by } => {
                    let rivals: Vec<String> = by
                        .iter()
                        .map(|&b| {
                            let prevent = why
                                .rivals
                                .iter()
                                .find(|r| r.unit == b)
                                .map_or(0, |r| r.prevent);
                            format!("{} (strength {prevent})", unit(b))
                        })
                        .collect();
                    format!(
                        "{me} bounced in {to} with {}: its own strength was {attack}{with_support}, and a move only succeeds when it is the strongest.",
                        list(&rivals)
                    )
                }
            }
        }
        OrderOutcome::Support(s) => match s {
            SupportOutcome::Succeeds => format!("{me} gave its support."),
            SupportOutcome::Cut { by } => {
                let cutters: Vec<String> = if why.cut_by.is_empty() {
                    vec![unit(*by)]
                } else {
                    why.cut_by.iter().map(|&c| unit(c)).collect()
                };
                format!(
                    "The support of {me} was cut by an attack from {}.",
                    list(&cutters)
                )
            }
            SupportOutcome::Dislodged { by } => format!(
                "{me} was dislodged by {}, so its support was lost.",
                unit(*by)
            ),
            SupportOutcome::Void => match order.command {
                Command::SupportHold { target } => format!(
                    "The support of {me} had no effect: {} was ordered to move, and a moving unit cannot be supported in place.",
                    unit(target)
                ),
                Command::SupportMove { target, dest, .. } => format!(
                    "The support of {me} had no effect: {} was not ordered to move to {}.",
                    unit(target),
                    place(dest)
                ),
                _ => format!("The support of {me} had no effect."),
            },
        },
        OrderOutcome::Convoy(c) => match c {
            ConvoyOutcome::Succeeds => format!("{me} convoyed."),
            ConvoyOutcome::Dislodged { by } => {
                format!("{me} was dislodged by {}, so its convoy failed.", unit(*by))
            }
            ConvoyOutcome::Paradox => format!(
                "The convoy of {me} failed: it was part of a convoy paradox, which the Szykman rule settles by failing the convoy."
            ),
            ConvoyOutcome::Void => match order.command {
                Command::Convoy { army, dest } => format!(
                    "The convoy of {me} had no effect: {} was not ordered to move to {} by convoy.",
                    unit(army),
                    place(dest)
                ),
                _ => format!("The convoy of {me} had no effect."),
            },
        },
    };

    // a failed move also says which of its supports fell away
    if matches!(out, OrderOutcome::Move(m) if *m != MoveOutcome::Succeeds)
        || matches!(out, OrderOutcome::Hold(HoldOutcome::Dislodged { .. }))
    {
        for note in why.supports.iter().filter_map(lost_support) {
            text.push(' ');
            text.push_str(&note);
        }
    }

    if let Some(cycle) = why.cycle.and_then(|c| explanation.cycles.get(c)) {
        let others: Vec<String> = cycle
            .members
            .iter()
            .filter(|&&m| m != index)
            .map(|&m| order_text(map, position, &explanation.orders[m]))
            .collect();
        let with = if others.is_empty() {
            String::new()
        } else {
            format!(" with {}", list(&others))
        };
        match cycle.kind {
            CycleKind::CircularMovement => text.push_str(&format!(
                " It was part of a circular movement{with}, in which every move succeeds."
            )),
            CycleKind::ConvoyParadox
                if !matches!(out, OrderOutcome::Convoy(ConvoyOutcome::Paradox)) =>
            {
                text.push_str(&format!(
                    " It depended on a convoy paradox{with}; the convoy fails and everything else resolves normally."
                ))
            }
            CycleKind::ConvoyParadox if others.is_empty() => {}
            CycleKind::ConvoyParadox => text.push_str(&format!(
                " The circle of orders that depend on one another also holds {}.",
                list(&others)
            )),
            CycleKind::Unresolved => text.push_str(&format!(
                " It depended in a circle{with} that no rule settles, so every order in it fails."
            )),
        }
    }
    text
}
