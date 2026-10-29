//! Geography: provinces, coasts, regions, borders and the map graph.
//!
//! A *province* is a named area on the board. A *region* is the thing a unit
//! stands on: for most provinces the region is the province itself, but a
//! province with named coasts (Spain, Bulgaria, St Petersburg) has one region
//! per coast for fleets plus the province-level region for armies.
//!
//! Borders carry a terrain that says which unit kinds may cross:
//! `Land` for armies only, `Sea` for fleets only, `Coast` for both.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;
use std::sync::OnceLock;

use crate::rulebook::RulebookOverrides;
use serde::{Deserialize, Serialize};

/// Index of a province in the map's province table.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProvinceId(pub u8);

/// Index of a power in the map's power table.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Power(pub u8);

/// A named coast of a multi-coast province.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Coast {
    North,
    South,
    East,
    West,
}

impl Coast {
    /// Parse `nc`, `sc`, `ec`, `wc`, `n`, `s`, `e`, `w` (any case).
    pub fn parse(s: &str) -> Option<Coast> {
        match s.to_ascii_lowercase().trim_end_matches('c') {
            "n" => Some(Coast::North),
            "s" => Some(Coast::South),
            "e" => Some(Coast::East),
            "w" => Some(Coast::West),
            _ => None,
        }
    }

    /// Two-letter code used in MILA notation (`NC`).
    pub fn code(self) -> &'static str {
        match self {
            Coast::North => "NC",
            Coast::South => "SC",
            Coast::East => "EC",
            Coast::West => "WC",
        }
    }
}

/// What a unit stands on. `coast` is `Some` only for fleets in a multi-coast province.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub struct Region {
    pub province: ProvinceId,
    pub coast: Option<Coast>,
}

impl Region {
    pub const fn new(province: ProvinceId, coast: Option<Coast>) -> Self {
        Region { province, coast }
    }

    pub const fn land(province: ProvinceId) -> Self {
        Region {
            province,
            coast: None,
        }
    }
}

/// Terrain of a province or of a border.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Terrain {
    Land,
    Coast,
    Sea,
}

/// Which unit kinds a border admits.
impl Terrain {
    pub fn passable_by(self, kind: UnitKind) -> bool {
        matches!(
            (self, kind),
            (Terrain::Land, UnitKind::Army) | (Terrain::Sea, UnitKind::Fleet) | (Terrain::Coast, _)
        )
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UnitKind {
    Army,
    Fleet,
}

impl UnitKind {
    pub fn letter(self) -> char {
        match self {
            UnitKind::Army => 'A',
            UnitKind::Fleet => 'F',
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SupplyCenter {
    None,
    Neutral,
    Home(Power),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Province {
    /// Three letter short name, lower case (`stp`).
    pub name: String,
    pub full_name: String,
    pub terrain: Terrain,
    pub supply_center: SupplyCenter,
    /// Named coasts, empty for single-coast and inland provinces.
    pub coasts: Vec<Coast>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PowerInfo {
    /// Three letter code (`ENG`).
    pub code: String,
    /// Display name (`England`).
    pub name: String,
}

/// The board graph.
#[derive(Clone, Debug)]
pub struct Map {
    pub name: String,
    /// Variant-specific rulebook settings declared by the map document.
    pub rulebook_overrides: RulebookOverrides,
    provinces: Vec<Province>,
    powers: Vec<PowerInfo>,
    by_name: HashMap<String, ProvinceId>,
    /// Outgoing borders per region.
    adjacency: BTreeMap<Region, Vec<(Region, Terrain)>>,
    /// Home supply centres per power, sorted by province id.
    homes: Vec<Vec<ProvinceId>>,
    /// Starting units, `(power, kind, region)`.
    start_units: Vec<(Power, UnitKind, Region)>,
    /// Province-level fleet adjacency, row-major `[from * len + to]`: can a fleet on
    /// any region of `from` move directly into some region of `to`? Precomputed so
    /// convoy route searches never allocate or walk border lists.
    fleet_adjacency: Vec<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MapDocument {
    name: String,
    provinces: Vec<MapProvince>,
    regions: Vec<MapRegion>,
    borders: Vec<MapBorder>,
    powers: Vec<PowerInfo>,
    homes: BTreeMap<String, Vec<String>>,
    starting_units: Vec<MapStartUnit>,
    #[serde(default)]
    rulebook_overrides: RulebookOverrides,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MapProvince {
    name: String,
    full_name: String,
    #[serde(default)]
    supply_center: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MapRegion {
    province: String,
    #[serde(default)]
    coast: Option<String>,
    terrain: Terrain,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MapBorder {
    from: String,
    to: String,
    terrain: Terrain,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MapStartUnit {
    power: String,
    kind: UnitKind,
    region: String,
}

#[derive(Debug, thiserror::Error)]
pub enum MapError {
    #[error("invalid map: {0}")]
    Invalid(String),
    #[error("unknown province {0}")]
    UnknownProvince(String),
    #[error("invalid map JSON: {0}")]
    Json(String),
}

impl Map {
    /// The classic 1901 map, parsed once and cached for the process lifetime.
    pub fn standard() -> &'static Map {
        static MAP: OnceLock<Map> = OnceLock::new();
        MAP.get_or_init(|| {
            Map::from_json(include_str!("../data/maps/standard.json"))
                .expect("bundled standard map is valid")
        })
    }

    /// Look up a bundled map by name. Only `standard` ships today; variant maps are data files.
    pub fn by_name(name: &str) -> Option<&'static Map> {
        match name.to_ascii_lowercase().as_str() {
            "standard" | "classic" => Some(Map::standard()),
            "duel" => {
                static DUEL: OnceLock<Map> = OnceLock::new();
                Some(DUEL.get_or_init(|| {
                    Map::from_json(include_str!("../data/maps/duel.json"))
                        .expect("bundled duel map is valid")
                }))
            }
            _ => None,
        }
    }

    /// Build a map from one self-contained JSON document (see `data/maps/`).
    pub fn from_json(json: &str) -> Result<Map, MapError> {
        let doc: MapDocument =
            serde_json::from_str(json).map_err(|e| MapError::Json(e.to_string()))?;
        Map::from_document(doc)
    }

    fn from_document(doc: MapDocument) -> Result<Map, MapError> {
        let invalid = |msg: String| MapError::Invalid(msg);
        let power_by_code: HashMap<&str, Power> = doc
            .powers
            .iter()
            .enumerate()
            .map(|(i, p)| (p.code.as_str(), Power(i as u8)))
            .collect();
        if doc.powers.is_empty() || doc.powers.len() > u8::MAX as usize {
            return Err(invalid(format!("bad power count {}", doc.powers.len())));
        }
        if power_by_code.len() != doc.powers.len() {
            return Err(invalid("duplicate power code".into()));
        }
        let power = |code: &str| {
            power_by_code
                .get(code)
                .copied()
                .ok_or_else(|| invalid(format!("unknown power {code}")))
        };

        let mut provinces = Vec::with_capacity(doc.provinces.len());
        let mut by_name = HashMap::with_capacity(doc.provinces.len());
        for p in &doc.provinces {
            let id = u8::try_from(provinces.len())
                .map(ProvinceId)
                .map_err(|_| invalid("more than 256 provinces".into()))?;
            let name = p.name.to_ascii_lowercase();
            if by_name.insert(name.clone(), id).is_some() {
                return Err(invalid(format!("duplicate province {name}")));
            }
            let supply_center = match p.supply_center.as_deref() {
                None => SupplyCenter::None,
                Some("neutral") => SupplyCenter::Neutral,
                Some(code) => SupplyCenter::Home(power(code)?),
            };
            provinces.push(Province {
                name,
                full_name: p.full_name.clone(),
                terrain: Terrain::Land, // refined from the region table
                supply_center,
                coasts: Vec::new(),
            });
        }

        for r in &doc.regions {
            let id = *by_name
                .get(&r.province.to_ascii_lowercase())
                .ok_or_else(|| MapError::UnknownProvince(r.province.clone()))?;
            let province = &mut provinces[id.0 as usize];
            match r.coast.as_deref() {
                None => province.terrain = r.terrain,
                Some(c) => {
                    let coast = Coast::parse(c).ok_or_else(|| invalid(format!("bad coast {c}")))?;
                    province.coasts.push(coast);
                    province.terrain = Terrain::Coast;
                }
            }
        }

        let mut adjacency: BTreeMap<Region, Vec<(Region, Terrain)>> = BTreeMap::new();
        for b in &doc.borders {
            let a = parse_region(&by_name, &b.from)?;
            let c = parse_region(&by_name, &b.to)?;
            adjacency.entry(a).or_default().push((c, b.terrain));
            adjacency.entry(c).or_default().push((a, b.terrain));
        }
        for edges in adjacency.values_mut() {
            edges.sort();
            edges.dedup();
        }

        let mut homes = vec![Vec::new(); doc.powers.len()];
        for (i, p) in provinces.iter().enumerate() {
            if let SupplyCenter::Home(power) = p.supply_center {
                homes[power.0 as usize].push(ProvinceId(i as u8));
            }
        }
        // `homes` restates the supply centre column so a variant author sees
        // each power's home set at a glance; the two must agree.
        if doc.homes.len() != doc.powers.len() {
            return Err(invalid("homes must list every power exactly once".into()));
        }
        for (code, named) in &doc.homes {
            let p = power(code)?;
            let mut actual: Vec<String> = named.iter().map(|s| s.to_ascii_lowercase()).collect();
            let mut expected: Vec<String> = homes[p.0 as usize]
                .iter()
                .map(|id| provinces[id.0 as usize].name.clone())
                .collect();
            actual.sort();
            expected.sort();
            if actual != expected {
                return Err(invalid(format!(
                    "home centres for {code} do not match province declarations"
                )));
            }
        }

        let mut start_units = Vec::with_capacity(doc.starting_units.len());
        for u in &doc.starting_units {
            start_units.push((power(&u.power)?, u.kind, parse_region(&by_name, &u.region)?));
        }

        let mut map = Map {
            name: doc.name,
            rulebook_overrides: doc.rulebook_overrides,
            provinces,
            powers: doc.powers,
            by_name,
            adjacency,
            homes,
            start_units,
            fleet_adjacency: Vec::new(),
        };
        let n = map.provinces.len();
        let mut fleet_adjacency = vec![false; n * n];
        for a in map.province_ids() {
            for r in map.regions_of(a) {
                for to in map.reachable(r, UnitKind::Fleet) {
                    fleet_adjacency[a.0 as usize * n + to.province.0 as usize] = true;
                }
            }
        }
        map.fleet_adjacency = fleet_adjacency;
        Ok(map)
    }

    pub fn provinces(&self) -> &[Province] {
        &self.provinces
    }

    pub fn province(&self, id: ProvinceId) -> &Province {
        &self.provinces[id.0 as usize]
    }

    pub fn province_ids(&self) -> impl Iterator<Item = ProvinceId> + '_ {
        (0..self.provinces.len()).map(|i| ProvinceId(i as u8))
    }

    /// Look up a province by short name (case-insensitive).
    pub fn find_province(&self, name: &str) -> Option<ProvinceId> {
        self.by_name.get(&name.to_ascii_lowercase()).copied()
    }

    pub fn powers(&self) -> &[PowerInfo] {
        &self.powers
    }

    pub fn power(&self, p: Power) -> &PowerInfo {
        &self.powers[p.0 as usize]
    }

    pub fn power_ids(&self) -> impl Iterator<Item = Power> + '_ {
        (0..self.powers.len()).map(|i| Power(i as u8))
    }

    /// Look up a power by three letter code or full name (case-insensitive).
    pub fn find_power(&self, s: &str) -> Option<Power> {
        let s = s.to_ascii_uppercase();
        self.powers
            .iter()
            .position(|p| p.code == s || p.name.to_ascii_uppercase() == s)
            .map(|i| Power(i as u8))
    }

    pub fn homes(&self, power: Power) -> &[ProvinceId] {
        &self.homes[power.0 as usize]
    }

    pub fn start_units(&self) -> &[(Power, UnitKind, Region)] {
        &self.start_units
    }

    /// All supply centre provinces.
    pub fn supply_centers(&self) -> impl Iterator<Item = ProvinceId> + '_ {
        self.province_ids()
            .filter(|&p| self.province(p).supply_center != SupplyCenter::None)
    }

    /// Borders leaving a region.
    pub fn borders(&self, region: Region) -> &[(Region, Terrain)] {
        self.adjacency
            .get(&region)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// Every region of a province: the land region plus one per named coast.
    pub fn regions_of(&self, province: ProvinceId) -> Vec<Region> {
        let mut v = vec![Region::land(province)];
        v.extend(
            self.province(province)
                .coasts
                .iter()
                .map(|&c| Region::new(province, Some(c))),
        );
        v
    }

    /// Regions a unit of `kind` standing on `from` can move to directly.
    pub fn reachable(&self, from: Region, kind: UnitKind) -> impl Iterator<Item = Region> + '_ {
        self.borders(from)
            .iter()
            .filter(move |(_, t)| t.passable_by(kind))
            .map(|(r, _)| *r)
    }

    /// Can a unit of `kind` at `from` move directly to `to`?
    pub fn adjacent(&self, from: Region, kind: UnitKind, to: Region) -> bool {
        self.reachable(from, kind).any(|r| r == to)
    }

    /// Can a unit of `kind` at `from` move directly to any region of `to`?
    pub fn adjacent_province(&self, from: Region, kind: UnitKind, to: ProvinceId) -> bool {
        self.reachable(from, kind).any(|r| r.province == to)
    }

    /// Can a fleet on any region of province `a` move directly into province `b`?
    pub fn fleet_adjacent(&self, a: ProvinceId, b: ProvinceId) -> bool {
        self.fleet_adjacency[a.0 as usize * self.provinces.len() + b.0 as usize]
    }

    /// Provinces adjacent to `p` by any border at all (used for civil disorder distance).
    pub fn neighbours_any(&self, p: ProvinceId) -> Vec<ProvinceId> {
        let mut v: Vec<ProvinceId> = self
            .regions_of(p)
            .into_iter()
            .flat_map(|r| self.borders(r).iter().map(|(to, _)| to.province))
            .collect();
        v.sort();
        v.dedup();
        v
    }

    /// Is this province a sea zone (fleets only, may convoy)?
    pub fn is_sea(&self, p: ProvinceId) -> bool {
        self.province(p).terrain == Terrain::Sea
    }

    /// Is this province coastal (armies may embark or land here)?
    pub fn is_coastal(&self, p: ProvinceId) -> bool {
        self.province(p).terrain == Terrain::Coast
    }

    /// Is this province inland (fleets may never enter)?
    pub fn is_inland(&self, p: ProvinceId) -> bool {
        self.province(p).terrain == Terrain::Land
    }

    /// Resolve the region a fleet moving from `from` would occupy in province `to`,
    /// given an optional requested coast. Implements DATC 4.B.1 to 4.B.3:
    /// returns `Err(Ambiguous)` when two coasts are reachable and none was named,
    /// `Err(Unreachable)` when the named coast (or the province) cannot be reached.
    pub fn fleet_destination(
        &self,
        from: Region,
        to: ProvinceId,
        coast: Option<Coast>,
    ) -> Result<Region, CoastError> {
        let candidates: Vec<Region> = self
            .reachable(from, UnitKind::Fleet)
            .filter(|r| r.province == to)
            .collect();
        if candidates.is_empty() {
            return Err(CoastError::Unreachable);
        }
        // DATC 4.B.6: annotations naming a coast that this province does not have
        // are irrelevant. A real but unreachable coast remains an error (4.B.3).
        let coast = coast.filter(|c| self.province(to).coasts.contains(c));
        match coast {
            Some(c) => {
                let want = Region::new(to, Some(c));
                if candidates.contains(&want) {
                    Ok(want)
                } else {
                    Err(CoastError::Unreachable)
                }
            }
            None => match candidates.as_slice() {
                [] => Err(CoastError::Unreachable),
                [one] => Ok(*one),
                _ => Err(CoastError::Ambiguous),
            },
        }
    }

    /// Breadth-first distance between provinces counting every border regardless of unit kind.
    /// Used by the 2023 civil disorder rule.
    pub fn distance_any(&self, from: ProvinceId, targets: &[ProvinceId]) -> Option<u32> {
        if targets.is_empty() {
            return None;
        }
        let mut seen = vec![false; self.provinces.len()];
        let mut queue = VecDeque::new();
        seen[from.0 as usize] = true;
        queue.push_back((from, 0u32));
        while let Some((p, d)) = queue.pop_front() {
            if targets.contains(&p) {
                return Some(d);
            }
            for n in self.neighbours_any(p) {
                if !seen[n.0 as usize] {
                    seen[n.0 as usize] = true;
                    queue.push_back((n, d + 1));
                }
            }
        }
        None
    }

    /// Format a region as MILA text (`STP/NC`).
    pub fn region_name(&self, r: Region) -> String {
        let base = self.province(r.province).name.to_ascii_uppercase();
        match r.coast {
            Some(c) => format!("{base}/{}", c.code()),
            None => base,
        }
    }

    /// Parse `stp`, `stp(nc)`, `STP/NC`, `stp/nc`, `stp nc`.
    pub fn parse_region(&self, s: &str) -> Option<Region> {
        let s = s.trim();
        let (name, coast) = split_coast(s);
        let province = self.find_province(name)?;
        match coast {
            None => Some(Region::land(province)),
            Some(c) => {
                let coast = Coast::parse(c)?;
                Some(Region::new(province, Some(coast)))
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CoastError {
    Ambiguous,
    Unreachable,
}

impl fmt::Display for CoastError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoastError::Ambiguous => write!(f, "coast must be specified"),
            CoastError::Unreachable => write!(f, "coast not reachable"),
        }
    }
}

/// Split `stp(nc)` / `stp/nc` / `stp nc` into `("stp", Some("nc"))`.
pub fn split_coast(s: &str) -> (&str, Option<&str>) {
    let s = s.trim();
    if let Some(i) = s.find('(') {
        let coast = s[i + 1..].trim_end_matches(')');
        return (s[..i].trim(), Some(coast));
    }
    if let Some((a, b)) = s.split_once('/') {
        return (a.trim(), Some(b.trim()));
    }
    (s, None)
}

fn parse_region(by_name: &HashMap<String, ProvinceId>, s: &str) -> Result<Region, MapError> {
    let (name, coast) = split_coast(s);
    let province = *by_name
        .get(&name.to_ascii_lowercase())
        .ok_or_else(|| MapError::UnknownProvince(name.to_string()))?;
    let coast = match coast {
        None => None,
        Some(c) => {
            Some(Coast::parse(c).ok_or_else(|| MapError::Invalid(format!("bad coast {c}")))?)
        }
    };
    Ok(Region::new(province, coast))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fleet_adjacency_matches_the_border_lists() {
        for m in [Map::standard(), Map::by_name("duel").unwrap()] {
            for a in m.province_ids() {
                for b in m.province_ids() {
                    let walked = m
                        .regions_of(a)
                        .into_iter()
                        .any(|r| m.adjacent_province(r, UnitKind::Fleet, b));
                    assert_eq!(m.fleet_adjacent(a, b), walked, "{a:?} -> {b:?}");
                }
            }
        }
    }

    #[test]
    fn standard_map_shape() {
        let m = Map::standard();
        assert_eq!(m.provinces().len(), 76); // 75 playable plus impassable Switzerland
        assert_eq!(m.supply_centers().count(), 34);
        assert_eq!(m.powers().len(), 7);
        assert_eq!(m.start_units().len(), 22);
        assert_eq!(m.homes(m.find_power("RUS").unwrap()).len(), 4);
    }

    #[test]
    fn coasts_and_reachability() {
        let m = Map::standard();
        let stp = m.find_province("stp").unwrap();
        assert_eq!(m.province(stp).coasts.len(), 2);
        let nwy = m.find_province("nwy").unwrap();
        let fleet_nwy = Region::land(nwy);
        assert_eq!(
            m.fleet_destination(fleet_nwy, stp, None),
            Ok(Region::new(stp, Some(Coast::North)))
        );
        let mao = m.find_province("mao").unwrap();
        let spa = m.find_province("spa").unwrap();
        assert_eq!(
            m.fleet_destination(Region::land(mao), spa, None),
            Err(CoastError::Ambiguous)
        );
        let lyo = m.find_province("lyo").unwrap();
        assert_eq!(
            m.fleet_destination(Region::land(lyo), spa, Some(Coast::North)),
            Err(CoastError::Unreachable)
        );
        // armies ignore coasts
        let gas = m.find_province("gas").unwrap();
        assert!(m.adjacent(Region::land(gas), UnitKind::Army, Region::land(spa)));
        // kiel canal: fleet hol -> kie, fleet kie -> ber
        let kie = m.find_province("kie").unwrap();
        let hol = m.find_province("hol").unwrap();
        let ber = m.find_province("ber").unwrap();
        assert!(m.adjacent(Region::land(hol), UnitKind::Fleet, Region::land(kie)));
        assert!(m.adjacent(Region::land(kie), UnitKind::Fleet, Region::land(ber)));
        // fleets never enter inland
        let mun = m.find_province("mun").unwrap();
        assert!(!m.adjacent(Region::land(kie), UnitKind::Fleet, Region::land(mun)));
        assert!(m.adjacent(Region::land(kie), UnitKind::Army, Region::land(mun)));
    }

    #[test]
    fn region_text_round_trip() {
        let m = Map::standard();
        for s in ["STP/NC", "stp(sc)", "bul/ec", "MAO"] {
            let r = m.parse_region(s).unwrap();
            assert_eq!(m.parse_region(&m.region_name(r)), Some(r));
        }
    }

    #[test]
    fn bundled_json_maps_load_standard_and_duel() {
        let standard = Map::standard();
        assert_eq!(standard.name, "standard");
        assert_eq!(standard.provinces().len(), 76);
        assert_eq!(Map::by_name("classic").unwrap().name, "standard");

        let duel = Map::by_name("duel").unwrap();
        assert_eq!(duel.powers().len(), 2);
        assert_eq!(duel.start_units().len(), 2);
        let game = crate::game::Game::new(duel, crate::rulebook::Rulebook::default());
        assert!(game.rulebook.build_anywhere);
        // A solo must be reachable: two of the three centres win.
        assert_eq!(game.rulebook.victory_centers, 2);
    }

    fn duel_doc() -> serde_json::Value {
        serde_json::from_str(include_str!("../data/maps/duel.json")).unwrap()
    }

    fn load(doc: &serde_json::Value) -> Result<Map, MapError> {
        Map::from_json(&doc.to_string())
    }

    #[test]
    fn map_documents_are_validated() {
        assert!(load(&duel_doc()).is_ok());

        let mut doc = duel_doc();
        doc["provinces"][1]["name"] = "red".into();
        assert!(
            matches!(load(&doc), Err(MapError::Invalid(m)) if m.contains("duplicate province"))
        );

        let mut doc = duel_doc();
        doc["homes"]["RED"] = serde_json::json!(["mid"]);
        assert!(matches!(load(&doc), Err(MapError::Invalid(m)) if m.contains("home centres")));

        let mut doc = duel_doc();
        doc["borders"][0]["to"] = "nowhere".into();
        assert!(matches!(load(&doc), Err(MapError::UnknownProvince(p)) if p == "nowhere"));

        let mut doc = duel_doc();
        doc["starting_units"][0]["power"] = "GREEN".into();
        assert!(matches!(load(&doc), Err(MapError::Invalid(m)) if m.contains("unknown power")));

        let mut doc = duel_doc();
        doc["rulebook_overrides"] = serde_json::json!({"build_anywere": true});
        assert!(matches!(load(&doc), Err(MapError::Json(_))));

        let mut doc = duel_doc();
        doc["regions"][0]["terrain"] = "lava".into();
        assert!(matches!(load(&doc), Err(MapError::Json(_))));
    }
}
