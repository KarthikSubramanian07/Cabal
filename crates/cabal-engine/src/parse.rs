//! Tolerant order text parser.
//!
//! Accepts MILA / Cicero notation (`A PAR - BUR`, `F NTH C A LON - BRE`,
//! `A LON - BRE VIA`, `F STP/NC`) and the DATC corpus dialect
//! (`F nth -> pic`, `A lvp supports A yor -> yor`, `F nth convoys yor -> yor`,
//! `A lon -> bel via Convoy`, `F stp build`, `A pic disband`, `stp(nc)`),
//! case-insensitively. Coast inference and legality are not done here; the
//! parser only produces a syntactic [`Parsed`] order.

use serde::{Deserialize, Serialize};

use crate::geo::{Coast, Map, Power, Region, UnitKind};
use crate::order::{AdjustCommand, AdjustOrder, Command, Order, RetreatCommand, RetreatOrder};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ParsedCommand {
    Hold,
    Move { dest: Region, via_convoy: bool },
    SupportHold { target: Region },
    SupportMove { target: Region, dest: Region },
    Convoy { army: Region, dest: Region },
    Disband,
    Build,
    Waive,
}

/// A syntactically valid order. `region` is the unit location as written
/// (coast included if given). `kind` is the unit kind as written, if any.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Parsed {
    pub power: Option<Power>,
    pub kind: Option<UnitKind>,
    /// `None` only for `WAIVE`.
    pub region: Option<Region>,
    pub command: ParsedCommand,
}

#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error, Serialize, Deserialize)]
pub enum ParseError {
    #[error("empty order")]
    Empty,
    #[error("unknown power {0}")]
    UnknownPower(String),
    #[error("unknown province {0}")]
    UnknownProvince(String),
    #[error("unexpected token {0}")]
    Unexpected(String),
    #[error("order is incomplete")]
    Incomplete,
    #[error("power is required")]
    MissingPower,
    #[error("{0} is not allowed in this phase")]
    NotInPhase(&'static str),
}

#[derive(Clone, PartialEq, Eq, Debug)]
enum Tok {
    Power(Power),
    Kind(UnitKind),
    Region(Region),
    Dash,
    Support,
    Convoy,
    Hold,
    Via,
    Retreat,
    Disband,
    Build,
    Waive,
    Word(String),
}

fn tokenize(map: &Map, text: &str) -> Result<Vec<Tok>, ParseError> {
    let cleaned: String = text
        .replace("->", " - ")
        .replace('(', " (")
        .replace(')', ") ")
        .replace(',', " ")
        .replace(';', " ")
        .to_ascii_uppercase();
    let mut toks = Vec::new();
    for raw in cleaned.split_whitespace() {
        let raw = raw.trim_matches('.');
        if raw.is_empty() {
            continue;
        }
        // coast in parentheses attaches to the previous region
        if let Some(inner) = raw.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
            if let (Some(Tok::Region(r)), Some(c)) = (toks.last_mut(), Coast::parse(inner)) {
                r.coast = Some(c);
                continue;
            }
            return Err(ParseError::Unexpected(raw.to_string()));
        }
        if let Some(p) = raw.strip_suffix(':') {
            let power = map.find_power(p).ok_or_else(|| ParseError::UnknownPower(p.to_string()))?;
            toks.push(Tok::Power(power));
            continue;
        }
        let tok = match raw {
            "A" | "ARMY" => Tok::Kind(UnitKind::Army),
            "F" | "FLEET" => Tok::Kind(UnitKind::Fleet),
            "-" | "TO" | "MOVE" | "MOVES" | "M" => Tok::Dash,
            "S" | "SUP" | "SUPPORT" | "SUPPORTS" => Tok::Support,
            "C" | "CONVOY" | "CONVOYS" => Tok::Convoy,
            "H" | "HOLD" | "HOLDS" | "STAND" | "STANDS" => Tok::Hold,
            "VIA" | "BY" => Tok::Via,
            "R" | "RETREAT" | "RETREATS" => Tok::Retreat,
            "D" | "DISBAND" | "DISBANDS" | "REMOVE" | "REMOVES" => Tok::Disband,
            "B" | "BUILD" | "BUILDS" => Tok::Build,
            "WAIVE" | "WAIVES" | "W" => Tok::Waive,
            other => match map.parse_region(other) {
                Some(r) => Tok::Region(r),
                None => {
                    // a bare power name without colon at the start ("ENGLAND F LON - NTH")
                    if toks.is_empty() {
                        if let Some(p) = map.find_power(other) {
                            Tok::Power(p)
                        } else {
                            Tok::Word(other.to_string())
                        }
                    } else {
                        Tok::Word(other.to_string())
                    }
                }
            },
        };
        toks.push(tok);
    }
    // "VIA CONVOY": drop the trailing CONVOY after VIA
    let mut out: Vec<Tok> = Vec::with_capacity(toks.len());
    for t in toks {
        if t == Tok::Convoy && out.last() == Some(&Tok::Via) {
            continue;
        }
        out.push(t);
    }
    Ok(out)
}

/// Parse one order line.
pub fn parse(map: &Map, text: &str) -> Result<Parsed, ParseError> {
    let toks = tokenize(map, text)?;
    if toks.is_empty() {
        return Err(ParseError::Empty);
    }
    let mut i = 0;
    let mut power = None;
    if let Some(Tok::Power(p)) = toks.get(i) {
        power = Some(*p);
        i += 1;
    }
    // WAIVE, or BUILD <kind> <region> forms
    match toks.get(i) {
        Some(Tok::Waive) => {
            return Ok(Parsed { power, kind: None, region: None, command: ParsedCommand::Waive });
        }
        Some(Tok::Build) => {
            let (kind, region) = kind_region(&toks, i + 1)?;
            return Ok(Parsed { power, kind, region: Some(region), command: ParsedCommand::Build });
        }
        Some(Tok::Disband) => {
            let (kind, region) = kind_region(&toks, i + 1)?;
            return Ok(Parsed { power, kind, region: Some(region), command: ParsedCommand::Disband });
        }
        _ => {}
    }
    let (kind, region) = kind_region(&toks, i)?;
    i += usize::from(kind.is_some()) + 1;
    let command = match toks.get(i) {
        None | Some(Tok::Hold) => ParsedCommand::Hold,
        Some(Tok::Dash) | Some(Tok::Retreat) => {
            let dest = region_at(&toks, i + 1)?;
            let via_convoy = matches!(toks.get(i + 2), Some(Tok::Via));
            let end = i + 2 + usize::from(via_convoy);
            expect_end(&toks, end)?;
            ParsedCommand::Move { dest, via_convoy }
        }
        Some(Tok::Support) => {
            let (_, target) = kind_region(&toks, i + 1)?;
            let j = i + 1 + usize::from(matches!(toks.get(i + 1), Some(Tok::Kind(_)))) + 1;
            match toks.get(j) {
                None | Some(Tok::Hold) => {
                    expect_end(&toks, j + usize::from(toks.get(j).is_some()))?;
                    ParsedCommand::SupportHold { target }
                }
                Some(Tok::Dash) => {
                    let dest = region_at(&toks, j + 1)?;
                    // tolerate a trailing VIA on the supported move
                    let end = j + 2 + usize::from(matches!(toks.get(j + 2), Some(Tok::Via)));
                    expect_end(&toks, end)?;
                    ParsedCommand::SupportMove { target, dest }
                }
                Some(t) => return Err(ParseError::Unexpected(format!("{t:?}"))),
            }
        }
        Some(Tok::Convoy) => {
            let (_, army) = kind_region(&toks, i + 1)?;
            let j = i + 1 + usize::from(matches!(toks.get(i + 1), Some(Tok::Kind(_)))) + 1;
            match toks.get(j) {
                Some(Tok::Dash) => {
                    let dest = region_at(&toks, j + 1)?;
                    expect_end(&toks, j + 2)?;
                    ParsedCommand::Convoy { army, dest }
                }
                _ => return Err(ParseError::Incomplete),
            }
        }
        Some(Tok::Disband) => {
            expect_end(&toks, i + 1)?;
            ParsedCommand::Disband
        }
        Some(Tok::Build) => {
            expect_end(&toks, i + 1)?;
            ParsedCommand::Build
        }
        Some(t) => return Err(ParseError::Unexpected(format!("{t:?}"))),
    };
    Ok(Parsed { power, kind, region: Some(region), command })
}

fn kind_region(toks: &[Tok], i: usize) -> Result<(Option<UnitKind>, Region), ParseError> {
    match toks.get(i) {
        Some(Tok::Kind(k)) => Ok((Some(*k), region_at(toks, i + 1)?)),
        Some(Tok::Region(r)) => Ok((None, *r)),
        Some(Tok::Word(w)) => Err(ParseError::UnknownProvince(w.clone())),
        Some(t) => Err(ParseError::Unexpected(format!("{t:?}"))),
        None => Err(ParseError::Incomplete),
    }
}

fn region_at(toks: &[Tok], i: usize) -> Result<Region, ParseError> {
    match toks.get(i) {
        Some(Tok::Region(r)) => Ok(*r),
        Some(Tok::Word(w)) => Err(ParseError::UnknownProvince(w.clone())),
        Some(t) => Err(ParseError::Unexpected(format!("{t:?}"))),
        None => Err(ParseError::Incomplete),
    }
}

fn expect_end(toks: &[Tok], i: usize) -> Result<(), ParseError> {
    match toks.get(i) {
        None => Ok(()),
        Some(t) => Err(ParseError::Unexpected(format!("{t:?}"))),
    }
}

impl Parsed {
    fn power_or(&self, default: Option<Power>) -> Result<Power, ParseError> {
        self.power.or(default).ok_or(ParseError::MissingPower)
    }

    /// Interpret as a movement phase order.
    pub fn to_movement(&self, default_power: Option<Power>) -> Result<Order, ParseError> {
        let power = self.power_or(default_power)?;
        let region = self.region.ok_or(ParseError::Incomplete)?;
        let command = match self.command {
            ParsedCommand::Hold => Command::Hold,
            ParsedCommand::Move { dest, via_convoy } => {
                Command::Move { dest: dest.province, coast: dest.coast, via_convoy }
            }
            ParsedCommand::SupportHold { target } => Command::SupportHold { target: target.province },
            ParsedCommand::SupportMove { target, dest } => {
                Command::SupportMove { target: target.province, dest: dest.province, coast: dest.coast }
            }
            ParsedCommand::Convoy { army, dest } => Command::Convoy { army: army.province, dest: dest.province },
            ParsedCommand::Disband => return Err(ParseError::NotInPhase("disband")),
            ParsedCommand::Build => return Err(ParseError::NotInPhase("build")),
            ParsedCommand::Waive => return Err(ParseError::NotInPhase("waive")),
        };
        Ok(Order { power, unit: region.province, command })
    }

    /// Interpret as a retreat phase order. Supports and convoys are illegal here (DATC 6.H.1 to 6.H.3).
    pub fn to_retreat(&self, default_power: Option<Power>) -> Result<RetreatOrder, ParseError> {
        let power = self.power_or(default_power)?;
        let region = self.region.ok_or(ParseError::Incomplete)?;
        let command = match self.command {
            ParsedCommand::Move { dest, .. } => RetreatCommand::Retreat { dest: dest.province, coast: dest.coast },
            ParsedCommand::Disband | ParsedCommand::Hold => RetreatCommand::Disband,
            ParsedCommand::SupportHold { .. } | ParsedCommand::SupportMove { .. } => {
                return Err(ParseError::NotInPhase("support"));
            }
            ParsedCommand::Convoy { .. } => return Err(ParseError::NotInPhase("convoy")),
            ParsedCommand::Build => return Err(ParseError::NotInPhase("build")),
            ParsedCommand::Waive => return Err(ParseError::NotInPhase("waive")),
        };
        Ok(RetreatOrder { power, unit: region.province, command })
    }

    /// Interpret as an adjustment phase order.
    pub fn to_adjustment(&self, default_power: Option<Power>) -> Result<AdjustOrder, ParseError> {
        let power = self.power_or(default_power)?;
        let command = match self.command {
            ParsedCommand::Waive => AdjustCommand::Waive,
            ParsedCommand::Build => {
                AdjustCommand::Build { kind: self.kind, region: self.region.ok_or(ParseError::Incomplete)? }
            }
            ParsedCommand::Disband => AdjustCommand::Disband { unit: self.region.ok_or(ParseError::Incomplete)?.province },
            ParsedCommand::Hold => return Err(ParseError::NotInPhase("hold")),
            ParsedCommand::Move { .. } => return Err(ParseError::NotInPhase("move")),
            ParsedCommand::SupportHold { .. } | ParsedCommand::SupportMove { .. } => {
                return Err(ParseError::NotInPhase("support"));
            }
            ParsedCommand::Convoy { .. } => return Err(ParseError::NotInPhase("convoy")),
        };
        Ok(AdjustOrder { power, command })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m() -> &'static Map {
        Map::standard()
    }

    fn reg(s: &str) -> Region {
        m().parse_region(s).unwrap()
    }

    #[test]
    fn mila_forms() {
        let p = parse(m(), "A PAR - BUR").unwrap();
        assert_eq!(p.command, ParsedCommand::Move { dest: reg("bur"), via_convoy: false });
        let p = parse(m(), "F NTH C A LON - BRE").unwrap();
        assert_eq!(p.command, ParsedCommand::Convoy { army: reg("lon"), dest: reg("bre") });
        let p = parse(m(), "A LON - BRE VIA").unwrap();
        assert_eq!(p.command, ParsedCommand::Move { dest: reg("bre"), via_convoy: true });
        let p = parse(m(), "A WAL S F LON").unwrap();
        assert_eq!(p.command, ParsedCommand::SupportHold { target: reg("lon") });
        let p = parse(m(), "A PAR S A BUR - PIC").unwrap();
        assert_eq!(p.command, ParsedCommand::SupportMove { target: reg("bur"), dest: reg("pic") });
        let p = parse(m(), "F LYO - SPA/SC").unwrap();
        assert_eq!(p.command, ParsedCommand::Move { dest: reg("spa/sc"), via_convoy: false });
        let p = parse(m(), "F BLA R SEV").unwrap();
        assert_eq!(p.command, ParsedCommand::Move { dest: reg("sev"), via_convoy: false });
        let p = parse(m(), "A PAR B").unwrap();
        assert_eq!(p.command, ParsedCommand::Build);
        assert_eq!(p.kind, Some(UnitKind::Army));
        let p = parse(m(), "F BRE D").unwrap();
        assert_eq!(p.command, ParsedCommand::Disband);
        let p = parse(m(), "WAIVE").unwrap();
        assert_eq!(p.command, ParsedCommand::Waive);
    }

    #[test]
    fn datc_forms() {
        let p = parse(m(), "ENG: F nth -> pic").unwrap();
        assert_eq!(p.power, m().find_power("ENG"));
        assert_eq!(p.command, ParsedCommand::Move { dest: reg("pic"), via_convoy: false });
        let p = parse(m(), "ENG: A lvp supports A yor -> yor").unwrap();
        assert_eq!(p.command, ParsedCommand::SupportMove { target: reg("yor"), dest: reg("yor") });
        let p = parse(m(), "ENG: F nth convoys yor -> yor").unwrap();
        assert_eq!(p.command, ParsedCommand::Convoy { army: reg("yor"), dest: reg("yor") });
        let p = parse(m(), "AUS: F tri supports F tri").unwrap();
        assert_eq!(p.command, ParsedCommand::SupportHold { target: reg("tri") });
        let p = parse(m(), "ENG: A lon -> bel via Convoy").unwrap();
        assert_eq!(p.command, ParsedCommand::Move { dest: reg("bel"), via_convoy: true });
        let p = parse(m(), "RUS: F stp(nc) build").unwrap();
        assert_eq!(p.command, ParsedCommand::Build);
        assert_eq!(p.region, Some(reg("stp/nc")));
        let p = parse(m(), "FRA: A pic disband").unwrap();
        assert_eq!(p.command, ParsedCommand::Disband);
        let p = parse(m(), "AUS: A ven Hold").unwrap();
        assert_eq!(p.command, ParsedCommand::Hold);
        let p = parse(m(), "England F lon - nth").unwrap();
        assert_eq!(p.power, m().find_power("ENG"));
    }

    #[test]
    fn errors() {
        assert!(matches!(parse(m(), ""), Err(ParseError::Empty)));
        assert!(matches!(parse(m(), "A XYZ - BUR"), Err(ParseError::UnknownProvince(_))));
        assert!(matches!(parse(m(), "A PAR -"), Err(ParseError::Incomplete)));
        assert!(matches!(parse(m(), "A PAR - BUR - PIC"), Err(ParseError::Unexpected(_))));
        let p = parse(m(), "A PAR S A BUR - PIC").unwrap();
        assert!(matches!(p.to_retreat(m().find_power("FRA")), Err(ParseError::NotInPhase("support"))));
        assert!(matches!(p.to_movement(None), Err(ParseError::MissingPower)));
    }
}
