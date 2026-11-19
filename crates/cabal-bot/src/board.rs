//! A read-only tactical view of one position: who stands where, who owns what,
//! and which units can reach which provinces. Built once per decision.

use std::ops::Deref;
use std::sync::OnceLock;

use cabal_engine::geo::{Map, Power, ProvinceId, Region, UnitKind};
use cabal_engine::order::Unit;
use cabal_engine::rulebook::Rulebook;
use cabal_engine::state::Position;

/// A set of provinces. Province ids are `u8`, so four words always suffice.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub(crate) struct Bits([u64; 4]);

impl Bits {
    pub(crate) fn set(&mut self, i: usize) {
        self.0[(i >> 6) & 3] |= 1 << (i & 63);
    }
    pub(crate) fn has(&self, i: usize) -> bool {
        self.0[(i >> 6) & 3] & (1 << (i & 63)) != 0
    }
}

/// Province-level adjacency and supply centre tables of a map.
#[derive(Debug)]
pub(crate) struct Tables {
    /// Provinces an army can walk to.
    pub army: Vec<Vec<usize>>,
    /// Provinces a fleet on any coast of the province can sail to.
    pub fleet: Vec<Vec<usize>>,
    /// Provinces sharing any border.
    pub any: Vec<Vec<usize>>,
    pub sc: Vec<bool>,
    pub centres: Vec<usize>,
    pub home: Vec<Option<Power>>,
    pub sea: Vec<bool>,
    pub coastal: Vec<bool>,
}

impl Tables {
    fn build(map: &Map) -> Tables {
        let n = map.provinces().len();
        let ids: Vec<ProvinceId> = map.province_ids().collect();
        let army = ids
            .iter()
            .map(|&p| {
                let mut v: Vec<usize> = map
                    .reachable(Region::land(p), UnitKind::Army)
                    .map(|r| r.province.0 as usize)
                    .collect();
                v.sort_unstable();
                v.dedup();
                v
            })
            .collect();
        let fleet = ids
            .iter()
            .map(|&p| {
                ids.iter()
                    .filter(|&&q| q != p && map.fleet_adjacent(p, q))
                    .map(|q| q.0 as usize)
                    .collect()
            })
            .collect();
        let any = ids
            .iter()
            .map(|&p| {
                map.neighbours_any(p)
                    .into_iter()
                    .map(|q| q.0 as usize)
                    .collect()
            })
            .collect();
        let sc: Vec<bool> = ids
            .iter()
            .map(|&p| map.province(p).supply_center != cabal_engine::geo::SupplyCenter::None)
            .collect();
        let home = ids
            .iter()
            .map(|&p| match map.province(p).supply_center {
                cabal_engine::geo::SupplyCenter::Home(q) => Some(q),
                _ => None,
            })
            .collect();
        Tables {
            army,
            fleet,
            any,
            centres: (0..n).filter(|&i| sc[i]).collect(),
            sc,
            home,
            sea: ids.iter().map(|&p| map.is_sea(p)).collect(),
            coastal: ids.iter().map(|&p| map.is_coastal(p)).collect(),
        }
    }

    pub(crate) fn of(&self, kind: UnitKind) -> &[Vec<usize>] {
        match kind {
            UnitKind::Army => &self.army,
            UnitKind::Fleet => &self.fleet,
        }
    }
}

/// The standard map's tables are built once per process; any other map gets a fresh set.
pub(crate) enum TablesRef {
    Shared(&'static Tables),
    Owned(Box<Tables>),
}

impl Deref for TablesRef {
    type Target = Tables;
    fn deref(&self) -> &Tables {
        match self {
            TablesRef::Shared(t) => t,
            TablesRef::Owned(t) => t,
        }
    }
}

pub(crate) fn tables(map: &Map) -> TablesRef {
    static STANDARD: OnceLock<Tables> = OnceLock::new();
    if std::ptr::eq(map, Map::standard()) {
        TablesRef::Shared(STANDARD.get_or_init(|| Tables::build(map)))
    } else {
        TablesRef::Owned(Box::new(Tables::build(map)))
    }
}

pub(crate) struct Board<'a> {
    pub map: &'a Map,
    pub t: &'a Tables,
    pub pos: &'a Position,
    pub rulebook: Rulebook,
    /// Fall movement: where units end the turn decides ownership.
    pub fall: bool,
    /// Index into `pos.units` of the unit in each province.
    pub occ: Vec<Option<usize>>,
    pub owner: Vec<Option<Power>>,
    /// Supply centres per power.
    pub centres: Vec<i32>,
    /// Per unit: regions it can move to directly, sorted.
    pub reach: Vec<Vec<Region>>,
    /// Per unit: the provinces of `reach`.
    pub reach_bits: Vec<Bits>,
    /// `[power][province]`: how many of that power's units can move there.
    pub pressure: Vec<Vec<u8>>,
    pub total_pressure: Vec<u8>,
}

impl<'a> Board<'a> {
    pub(crate) fn new(
        map: &'a Map,
        t: &'a Tables,
        pos: &'a Position,
        rulebook: Rulebook,
        fall: bool,
    ) -> Board<'a> {
        let n = map.provinces().len();
        let np = map.powers().len();
        let mut occ = vec![None; n];
        let mut reach = Vec::with_capacity(pos.units.len());
        let mut reach_bits = Vec::with_capacity(pos.units.len());
        let mut pressure = vec![vec![0u8; n]; np];
        let mut total_pressure = vec![0u8; n];
        for (i, u) in pos.units.iter().enumerate() {
            occ[u.province().0 as usize] = Some(i);
            let mut regions: Vec<Region> = map.reachable(u.region, u.kind).collect();
            regions.sort();
            regions.dedup();
            let mut bits = Bits::default();
            for r in &regions {
                bits.set(r.province.0 as usize);
            }
            for x in 0..n {
                if bits.has(x) {
                    pressure[u.power.0 as usize][x] += 1;
                    total_pressure[x] += 1;
                }
            }
            reach.push(regions);
            reach_bits.push(bits);
        }
        let mut owner = vec![None; n];
        let mut centres = vec![0i32; np];
        for (&p, &q) in &pos.owners {
            owner[p.0 as usize] = Some(q);
            centres[q.0 as usize] += 1;
        }
        Board {
            map,
            t,
            pos,
            rulebook,
            fall,
            occ,
            owner,
            centres,
            reach,
            reach_bits,
            pressure,
            total_pressure,
        }
    }

    pub(crate) fn unit(&self, i: usize) -> &Unit {
        &self.pos.units[i]
    }

    pub(crate) fn units_of(&self, power: Power) -> Vec<usize> {
        (0..self.pos.units.len())
            .filter(|&i| self.pos.units[i].power == power)
            .collect()
    }

    /// Units of other powers that can move into `x`.
    pub(crate) fn enemy_reach(&self, me: Power, x: usize) -> i32 {
        i32::from(self.total_pressure[x]) - i32::from(self.pressure[me.0 as usize][x])
    }

    /// The unit of another power standing in `x`, if any.
    pub(crate) fn foreign_at(&self, me: Power, x: usize) -> Option<usize> {
        self.occ[x].filter(|&i| self.pos.units[i].power != me)
    }

    pub(crate) fn own_at(&self, me: Power, x: usize) -> Option<usize> {
        self.occ[x].filter(|&i| self.pos.units[i].power == me)
    }

    /// A centre `me` does not own.
    pub(crate) fn prize(&self, me: Power, x: usize) -> bool {
        self.t.sc[x] && self.owner[x] != Some(me)
    }

    /// Can unit `i` give support into province `x`?
    pub(crate) fn can_support(&self, i: usize, x: usize) -> bool {
        self.reach_bits[i].has(x)
    }
}

/// Does every id in the position exist on this map? The bot refuses to index otherwise.
pub(crate) fn position_fits(map: &Map, pos: &Position) -> bool {
    let n = map.provinces().len();
    let np = map.powers().len();
    let mut seen = Bits::default();
    for u in &pos.units {
        let x = u.province().0 as usize;
        if x >= n || u.power.0 as usize >= np || seen.has(x) {
            return false;
        }
        seen.set(x);
    }
    pos.owners
        .iter()
        .all(|(p, q)| (p.0 as usize) < n && (q.0 as usize) < np)
}
