//! Rulebook editions as data. See docs/RULES.md for the reasoning behind each choice.

use serde::{Deserialize, Serialize};

/// When does an army ordered to an adjacent province travel by convoy? (DATC 4.A.3)
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvoyIntent {
    /// 1971: any legally ordered convoying fleet makes the move a convoy.
    AnyFleet,
    /// 1982 and 2023: `via convoy` or a same-power fleet legally ordered to convoy.
    SamePowerFleet,
    /// DPTG: only an explicit `via convoy`.
    Explicit,
}

/// Which supply centres civil disorder distance is measured to. (DATC 4.D.8)
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisbandDistance {
    /// Pre-2023: distance to the power's home centres.
    HomeCenters,
    /// 2023: distance to the nearest centre the power owns.
    OwnedCenters,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Edition {
    E1971,
    E1982,
    E2023,
    Dptg,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Rulebook {
    pub edition: Edition,
    pub convoy_intent: ConvoyIntent,
    pub disband_distance: DisbandDistance,
    /// 1971 only: an army whose (unwanted) convoy is disrupted takes the land route instead (DATC 6.G.4).
    pub convoy_fallback: bool,
    /// Variant flag: build in any owned supply centre.
    pub build_anywhere: bool,
    /// Supply centres needed for a solo victory.
    pub victory_centers: u8,
}

impl Rulebook {
    pub const fn edition_2023() -> Self {
        Rulebook {
            edition: Edition::E2023,
            convoy_fallback: false,
            convoy_intent: ConvoyIntent::SamePowerFleet,
            disband_distance: DisbandDistance::OwnedCenters,
            build_anywhere: false,
            victory_centers: 18,
        }
    }

    pub const fn edition_1982() -> Self {
        Rulebook {
            edition: Edition::E1982,
            convoy_fallback: false,
            convoy_intent: ConvoyIntent::SamePowerFleet,
            disband_distance: DisbandDistance::HomeCenters,
            build_anywhere: false,
            victory_centers: 18,
        }
    }

    pub const fn edition_1971() -> Self {
        Rulebook {
            edition: Edition::E1971,
            convoy_fallback: true,
            convoy_intent: ConvoyIntent::AnyFleet,
            disband_distance: DisbandDistance::HomeCenters,
            build_anywhere: false,
            victory_centers: 18,
        }
    }

    pub const fn dptg() -> Self {
        Rulebook {
            edition: Edition::Dptg,
            convoy_fallback: false,
            convoy_intent: ConvoyIntent::Explicit,
            disband_distance: DisbandDistance::OwnedCenters,
            build_anywhere: false,
            victory_centers: 18,
        }
    }

    pub fn by_name(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "1971" => Some(Self::edition_1971()),
            "1982" => Some(Self::edition_1982()),
            "2023" => Some(Self::edition_2023()),
            "dptg" => Some(Self::dptg()),
            _ => None,
        }
    }
}

impl Default for Rulebook {
    fn default() -> Self {
        Self::edition_2023()
    }
}
