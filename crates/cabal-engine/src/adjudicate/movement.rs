//! Movement phase resolution: the partial information algorithm of DATC v3.0 chapter 5.E.
//!
//! Every order is a Boolean equation over the strengths defined in chapter 5.B.
//! `adjudicate` evaluates one equation, asking `resolve` for the results of the
//! orders it depends on; `resolve` memoises, detects dependency cycles with the
//! `recursion_hits` counter, and applies the backup rules (circular movement
//! succeeds, convoy paradoxes fail the convoys per the Szykman rule).
//!
//! Illegal orders are stripped before resolution and never influence it
//! (DATC 4.E.1): the unit holds and may receive hold support.

use std::collections::{BTreeSet, HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::geo::{Map, Power, ProvinceId, Region, UnitKind};
use crate::order::{Command, Order, Unit};
use crate::outcome::{
    ConvoyOutcome, HoldOutcome, Illegal, MoveOutcome, OrderOutcome, SupportOutcome,
};
use crate::rulebook::{ConvoyIntent, Rulebook};
use crate::state::{Dislodged, Position};

/// Result of a movement phase.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct MovementResult {
    /// The effective order of every unit on the board (holds injected), sorted by unit region.
    pub orders: Vec<Order>,
    /// One outcome per entry in `orders`.
    pub outcomes: Vec<OrderOutcome>,
    /// Position after successful moves; dislodged units are removed. Ownership unchanged.
    pub position: Position,
    pub dislodged: Vec<Dislodged>,
    /// Provinces left vacant by a standoff (no retreats allowed there).
    pub standoffs: BTreeSet<ProvinceId>,
}

impl MovementResult {
    /// Outcome for the unit in `province`, if any.
    pub fn outcome_at(&self, province: ProvinceId) -> Option<&OrderOutcome> {
        self.orders
            .iter()
            .position(|o| o.unit == province)
            .map(|i| &self.outcomes[i])
    }
}

/// Resolve a movement phase. `orders` may contain illegal, duplicate or foreign orders;
/// they are reported as `Illegal` outcomes on the affected unit.
pub fn resolve_movement(
    map: &Map,
    position: &Position,
    rulebook: Rulebook,
    orders: &[Order],
) -> MovementResult {
    let mut r = Resolver::new(map, position, rulebook, orders);
    for i in 0..r.entries.len() {
        r.resolve(i, true);
    }
    r.finish()
}

#[derive(Clone, Debug)]
struct Entry {
    unit: Unit,
    /// Effective command: illegal orders become `Hold`.
    command: Command,
    illegal: Option<Illegal>,
    /// For moves: the region the unit will occupy if it succeeds.
    dest_region: Option<Region>,
    /// For moves: whether the move travels by convoy (decided statically, DATC 4.A.3).
    by_convoy: bool,
    /// For moves: the entry index of the head-to-head opponent, if any.
    head_to_head: Option<usize>,
    /// For convoyed moves under the 1971 fallback rule: the land route is available too.
    land_fallback: bool,
}

impl Entry {
    fn is_move(&self) -> bool {
        matches!(self.command, Command::Move { .. })
    }
    fn dest(&self) -> Option<ProvinceId> {
        match self.command {
            Command::Move { dest, .. } => Some(dest),
            _ => None,
        }
    }
    fn province(&self) -> ProvinceId {
        self.unit.province()
    }
}

struct Resolver<'a> {
    map: &'a Map,
    entries: Vec<Entry>,
    /// entry index by province
    at: HashMap<ProvinceId, usize>,
    /// move entries by destination province
    attackers: HashMap<ProvinceId, Vec<usize>>,
    /// support-move entries matching each move entry
    move_supports: Vec<Vec<usize>>,
    /// support-hold entries targeting each province (only counted when the target does not move)
    hold_supports: HashMap<ProvinceId, Vec<usize>>,
    /// convoy entries matching each move entry
    convoys_for: Vec<Vec<usize>>,
    /// whether a support or convoy order matches some legal order (else it is void)
    matched: Vec<bool>,

    // resolver administration (DATC 5.E)
    resolved: Vec<Option<bool>>,
    visited: Vec<bool>,
    cycle: Vec<usize>,
    recursion_hits: usize,
    uncertain: bool,
    paradox: Vec<bool>,
}

impl<'a> Resolver<'a> {
    fn new(map: &'a Map, position: &'a Position, rulebook: Rulebook, orders: &[Order]) -> Self {
        // one entry per unit, sorted by region
        let mut units: Vec<Unit> = position.units.clone();
        units.sort_by_key(|u| u.region);
        let mut entries: Vec<Entry> = units
            .iter()
            .map(|&unit| Entry {
                unit,
                command: Command::Hold,
                illegal: None,
                dest_region: None,
                by_convoy: false,
                head_to_head: None,
                land_fallback: false,
            })
            .collect();
        let at: HashMap<ProvinceId, usize> = entries
            .iter()
            .enumerate()
            .map(|(i, e)| (e.province(), i))
            .collect();

        // group submitted orders by unit; duplicates make every order for that unit illegal
        let mut per_unit: HashMap<ProvinceId, Vec<&Order>> = HashMap::new();
        for o in orders {
            per_unit.entry(o.unit).or_default().push(o);
        }
        for (province, list) in per_unit {
            let Some(&i) = at.get(&province) else {
                continue;
            }; // NoUnit: nothing to attach it to
            let e = &mut entries[i];
            if list.len() > 1 {
                // DATC 4.D.3: all orders illegal, unit holds
                e.illegal = Some(Illegal::DuplicateOrder);
                continue;
            }
            let o = list[0];
            if o.power != e.unit.power {
                e.illegal = Some(Illegal::ForeignUnit);
                continue;
            }
            e.command = o.command;
        }

        let fleet_seas: BTreeSet<ProvinceId> = units
            .iter()
            .filter(|u| u.kind == UnitKind::Fleet && map.is_sea(u.province()))
            .map(|u| u.province())
            .collect();

        // validate each command (DATC section 3 / 4.E.1)
        for i in 0..entries.len() {
            let e = &entries[i];
            if e.illegal.is_some() {
                continue;
            }
            let unit = e.unit;
            let verdict: Result<(Option<Region>, bool), Illegal> = match e.command {
                Command::Hold => Ok((None, false)),
                Command::Move {
                    dest,
                    coast,
                    via_convoy,
                } => {
                    if dest == unit.province() {
                        Err(Illegal::MoveToSelf)
                    } else {
                        match unit.kind {
                            UnitKind::Army => {
                                if map.adjacent_province(unit.region, UnitKind::Army, dest) {
                                    Ok((Some(Region::land(dest)), via_convoy))
                                } else if convoy_possible(map, &fleet_seas, unit.province(), dest) {
                                    Ok((Some(Region::land(dest)), true))
                                } else {
                                    Err(Illegal::Unreachable)
                                }
                            }
                            UnitKind::Fleet => {
                                match map.fleet_destination(unit.region, dest, coast) {
                                    Ok(r) => Ok((Some(r), false)),
                                    Err(crate::geo::CoastError::Ambiguous) => {
                                        Err(Illegal::AmbiguousCoast)
                                    }
                                    Err(crate::geo::CoastError::Unreachable) => {
                                        Err(Illegal::Unreachable)
                                    }
                                }
                            }
                        }
                    }
                }
                Command::SupportHold { target } => {
                    if target == unit.province() {
                        Err(Illegal::SupportSelf)
                    } else if !at.contains_key(&target) {
                        Err(Illegal::SupportNoUnit)
                    } else if !map.adjacent_province(unit.region, unit.kind, target) {
                        Err(Illegal::SupportUnreachable)
                    } else {
                        Ok((None, false))
                    }
                }
                Command::SupportMove { target, dest, .. } => {
                    if target == unit.province() {
                        Err(Illegal::SupportSelf)
                    } else if dest == unit.province() {
                        Err(Illegal::Unreachable)
                    } else if !at.contains_key(&target) {
                        Err(Illegal::SupportNoUnit)
                    } else if !map.adjacent_province(unit.region, unit.kind, dest) {
                        Err(Illegal::SupportUnreachable)
                    } else {
                        Ok((None, false))
                    }
                }
                Command::Convoy { army, dest } => {
                    if unit.kind != UnitKind::Fleet || !map.is_sea(unit.province()) {
                        Err(Illegal::ConvoyNotAtSea)
                    } else if !at
                        .get(&army)
                        .map(|&j| entries[j].unit.kind == UnitKind::Army)
                        .unwrap_or(false)
                    {
                        Err(Illegal::ConvoyNotArmy)
                    } else if !map.is_coastal(army) || !map.is_coastal(dest) || army == dest {
                        Err(Illegal::Unreachable)
                    } else if !on_convoy_route(map, &fleet_seas, army, dest, unit.province()) {
                        Err(Illegal::ConvoyNoRoute)
                    } else {
                        Ok((None, false))
                    }
                }
            };
            let e = &mut entries[i];
            match verdict {
                Ok((dest_region, by_convoy)) => {
                    e.dest_region = dest_region;
                    e.by_convoy = by_convoy;
                }
                Err(reason) => {
                    e.illegal = Some(reason);
                    e.command = Command::Hold;
                }
            }
        }

        // convoy intent for adjacent army moves (DATC 4.A.3)
        for i in 0..entries.len() {
            let e = &entries[i];
            let Command::Move { dest, .. } = e.command else {
                continue;
            };
            if e.unit.kind != UnitKind::Army || e.by_convoy {
                continue;
            }
            let intent = entries.iter().any(|c| {
                matches!(c.command, Command::Convoy { army, dest: d } if army == e.province() && d == dest)
                    && c.illegal.is_none()
                    && match rulebook.convoy_intent {
                        ConvoyIntent::AnyFleet => true,
                        ConvoyIntent::SamePowerFleet => c.unit.power == e.unit.power,
                        ConvoyIntent::Explicit => false,
                    }
            });
            if intent {
                entries[i].by_convoy = true;
            }
        }

        // 1971 fallback: a convoyed move to an adjacent province may still go by land
        if rulebook.convoy_fallback {
            for e in entries.iter_mut() {
                if let Command::Move { dest, .. } = e.command {
                    if e.by_convoy && map.adjacent_province(e.unit.region, e.unit.kind, dest) {
                        e.land_fallback = true;
                    }
                }
            }
        }

        // head-to-head candidates: mutual moves. Whether the battle applies is decided
        // during resolution (`h2h`), since convoyed units do not fight head-to-head.
        for i in 0..entries.len() {
            let Some(dest) = entries[i].dest() else {
                continue;
            };
            if let Some(&j) = at.get(&dest) {
                if entries[j].dest() == Some(entries[i].province()) {
                    entries[i].head_to_head = Some(j);
                }
            }
        }

        // indexes
        let mut attackers: HashMap<ProvinceId, Vec<usize>> = HashMap::new();
        for (i, e) in entries.iter().enumerate() {
            if let Some(d) = e.dest() {
                attackers.entry(d).or_default().push(i);
            }
        }
        let n = entries.len();
        let mut move_supports = vec![Vec::new(); n];
        let mut convoys_for = vec![Vec::new(); n];
        let mut hold_supports: HashMap<ProvinceId, Vec<usize>> = HashMap::new();
        let mut matched = vec![true; n];
        for (s, e) in entries.iter().enumerate() {
            match e.command {
                Command::SupportMove {
                    target,
                    dest,
                    coast,
                } => {
                    let m = at.get(&target).copied().filter(|&m| {
                        entries[m].dest() == Some(dest)
                            && coast.is_none_or(|c| {
                                entries[m].dest_region.and_then(|r| r.coast) == Some(c)
                            })
                    });
                    match m {
                        Some(m) => move_supports[m].push(s),
                        None => matched[s] = false,
                    }
                }
                Command::SupportHold { target } => {
                    let t = at[&target];
                    if entries[t].is_move() {
                        matched[s] = false;
                    } else {
                        hold_supports.entry(target).or_default().push(s);
                    }
                }
                Command::Convoy { army, dest } => {
                    let m = at
                        .get(&army)
                        .copied()
                        .filter(|&m| entries[m].dest() == Some(dest) && entries[m].by_convoy);
                    match m {
                        Some(m) => convoys_for[m].push(s),
                        None => matched[s] = false,
                    }
                }
                _ => {}
            }
        }

        Resolver {
            map,
            entries,
            at,
            attackers,
            move_supports,
            hold_supports,
            convoys_for,
            matched,
            resolved: vec![None; n],
            visited: vec![false; n],
            cycle: Vec::new(),
            recursion_hits: 0,
            uncertain: false,
            paradox: vec![false; n],
        }
    }

    // ---- resolve (DATC 5.E, final form) ----

    fn resolve(&mut self, i: usize, optimistic: bool) -> bool {
        if let Some(r) = self.resolved[i] {
            return r;
        }
        if self.cycle.contains(&i) {
            self.uncertain = true;
            return optimistic;
        }
        if self.visited[i] {
            self.cycle.push(i);
            self.recursion_hits += 1;
            self.uncertain = true;
            return optimistic;
        }
        self.visited[i] = true;
        let old_cycle_len = self.cycle.len();
        let old_hits = self.recursion_hits;
        let old_uncertain = self.uncertain;
        self.uncertain = false;
        let opt = self.adjudicate(i, true);
        let pes = if self.uncertain && opt {
            self.adjudicate(i, false)
        } else {
            opt
        };
        self.visited[i] = false;

        if opt == pes {
            self.cycle.truncate(old_cycle_len);
            self.recursion_hits = old_hits;
            self.uncertain = old_uncertain;
            self.resolved[i] = Some(opt);
            return opt;
        }
        if self.cycle.contains(&i) {
            self.recursion_hits -= 1;
        }
        if self.recursion_hits == old_hits {
            let members: Vec<usize> = self.cycle[old_cycle_len..].to_vec();
            self.backup_rule(&members);
            self.cycle.truncate(old_cycle_len);
            self.uncertain = old_uncertain;
            return self.resolve(i, optimistic);
        }
        if !self.cycle.contains(&i) {
            self.cycle.push(i);
        }
        optimistic
    }

    fn backup_rule(&mut self, members: &[usize]) {
        if members.iter().all(|&m| self.entries[m].is_move()) {
            // circular movement: every move succeeds
            for &m in members {
                self.resolved[m] = Some(true);
            }
            return;
        }
        let convoys: Vec<usize> = members
            .iter()
            .copied()
            .filter(|&m| matches!(self.entries[m].command, Command::Convoy { .. }))
            .collect();
        if !convoys.is_empty() {
            // Szykman: the convoys fail, everything else resolves normally
            for c in convoys {
                self.paradox[c] = true;
                self.resolved[c] = Some(false);
            }
            return;
        }
        for &m in members {
            self.resolved[m] = Some(false);
        }
    }

    // ---- adjudicate: the equations of DATC 5.B ----

    fn adjudicate(&mut self, i: usize, opt: bool) -> bool {
        match self.entries[i].command {
            Command::Hold => true,
            Command::Move { dest, .. } => {
                let atk = self.attack_strength(i, opt);
                if atk == 0 {
                    return false;
                }
                match self.h2h(i, opt) {
                    Some(j) => {
                        if atk <= self.defend_strength(j, !opt) {
                            return false;
                        }
                    }
                    None => {
                        if atk <= self.hold_strength(dest, !opt) {
                            return false;
                        }
                    }
                }
                let competitors = self.attackers.get(&dest).cloned().unwrap_or_default();
                for k in competitors {
                    if k != i && atk <= self.prevent_strength(k, !opt) {
                        return false;
                    }
                }
                true
            }
            Command::SupportHold { target } => self.adjudicate_support(i, target, opt),
            Command::SupportMove { dest, .. } => self.adjudicate_support(i, dest, opt),
            Command::Convoy { .. } => {
                if self.paradox[i] {
                    return false;
                }
                !self.dislodged_by_any(i, !opt)
            }
        }
    }

    /// DATC 5.B.2. `supported_dest` is the province the supported action targets.
    fn adjudicate_support(&mut self, i: usize, supported_dest: ProvinceId, opt: bool) -> bool {
        let me = self.entries[i].unit;
        let attackers = self
            .attackers
            .get(&me.province())
            .cloned()
            .unwrap_or_default();
        for m in attackers {
            if self.entries[m].unit.power == me.power {
                continue;
            }
            if self.entries[m].province() == supported_dest {
                // the unit we support an attack against cannot cut us by attacking,
                // but it does cut if it dislodges us
                if self.resolve(m, !opt) {
                    return false;
                }
                continue;
            }
            if self.path(m, !opt) {
                return false;
            }
        }
        true
    }

    /// Is some move into entry `i`'s province successful?
    fn dislodged_by_any(&mut self, i: usize, opt: bool) -> bool {
        let p = self.entries[i].province();
        let attackers = self.attackers.get(&p).cloned().unwrap_or_default();
        for m in attackers {
            if self.resolve(m, opt) {
                return true;
            }
        }
        false
    }

    /// Head-to-head opponent of move `i`, if the battle applies: both units must take the
    /// land route. A convoyed unit never fights head-to-head, except under the 1971 fallback
    /// rule when its convoy route has failed.
    fn h2h(&mut self, i: usize, opt: bool) -> Option<usize> {
        let j = self.entries[i].head_to_head?;
        if self.uses_land(i, opt) && self.uses_land(j, opt) {
            Some(j)
        } else {
            None
        }
    }

    fn uses_land(&mut self, i: usize, opt: bool) -> bool {
        let e = &self.entries[i];
        if !e.by_convoy {
            true
        } else if e.land_fallback {
            !self.convoy_path(i, opt)
        } else {
            false
        }
    }

    /// The convoy route of move `i` under the given assumption (no land fallback).
    fn convoy_path(&mut self, i: usize, opt: bool) -> bool {
        let origin = self.entries[i].province();
        let Some(dest) = self.entries[i].dest() else {
            return false;
        };
        let fleets = self.convoys_for[i].clone();
        let mut seas: Vec<ProvinceId> = Vec::new();
        for f in fleets {
            if self.resolve(f, opt) {
                seas.push(self.entries[f].province());
            }
        }
        sea_path_exists(self.map, &seas, origin, dest)
    }

    /// DATC 5.B.4 PATH.
    fn path(&mut self, i: usize, opt: bool) -> bool {
        if !self.entries[i].by_convoy {
            return true;
        }
        self.convoy_path(i, opt) || self.entries[i].land_fallback
    }

    /// Did the convoy route itself succeed (ignoring any land fallback)?
    fn convoy_path_final(&mut self, i: usize) -> bool {
        if !self.entries[i].by_convoy {
            return false;
        }
        let origin = self.entries[i].province();
        let Some(dest) = self.entries[i].dest() else {
            return false;
        };
        let fleets = self.convoys_for[i].clone();
        let seas: Vec<ProvinceId> = fleets
            .into_iter()
            .filter(|&f| self.resolved[f] == Some(true))
            .map(|f| self.entries[f].province())
            .collect();
        sea_path_exists(self.map, &seas, origin, dest)
    }

    fn supports(&mut self, i: usize, opt: bool, exclude_power: Option<Power>) -> u32 {
        let list = self.move_supports[i].clone();
        let mut n = 0;
        for s in list {
            if exclude_power == Some(self.entries[s].unit.power) {
                continue;
            }
            if self.resolve(s, opt) {
                n += 1;
            }
        }
        n
    }

    /// DATC 5.B.5.
    fn hold_strength(&mut self, p: ProvinceId, opt: bool) -> u32 {
        let Some(&e) = self.at.get(&p) else { return 0 };
        if self.entries[e].is_move() {
            return if self.resolve(e, !opt) { 0 } else { 1 };
        }
        let list = self.hold_supports.get(&p).cloned().unwrap_or_default();
        let mut n = 1;
        for s in list {
            if self.resolve(s, opt) {
                n += 1;
            }
        }
        n
    }

    /// DATC 5.B.8.
    fn attack_strength(&mut self, i: usize, opt: bool) -> u32 {
        if !self.path(i, opt) {
            return 0;
        }
        let dest = self.entries[i].dest().expect("move");
        let me = self.entries[i].unit.power;
        match self.at.get(&dest).copied() {
            None => 1 + self.supports(i, opt, None),
            Some(d) => {
                let leaves =
                    self.h2h(i, opt).is_none() && self.entries[d].is_move() && self.resolve(d, opt);
                if leaves {
                    1 + self.supports(i, opt, None)
                } else if self.entries[d].unit.power == me {
                    0
                } else {
                    let their = self.entries[d].unit.power;
                    1 + self.supports(i, opt, Some(their))
                }
            }
        }
    }

    /// DATC 5.B.7.
    fn defend_strength(&mut self, j: usize, opt: bool) -> u32 {
        1 + self.supports(j, opt, None)
    }

    /// DATC 5.B.6.
    fn prevent_strength(&mut self, k: usize, opt: bool) -> u32 {
        if !self.path(k, opt) {
            return 0;
        }
        if let Some(j) = self.h2h(k, opt) {
            if self.resolve(j, !opt) {
                return 0;
            }
        }
        1 + self.supports(k, opt, None)
    }

    // ---- explanation and bookkeeping ----

    #[allow(clippy::needless_range_loop)] // indices are shared across several parallel tables
    fn finish(mut self) -> MovementResult {
        let n = self.entries.len();
        let ok: Vec<bool> = (0..n).map(|i| self.resolved[i].unwrap_or(false)).collect();
        let moved_v: Vec<bool> = (0..n).map(|i| self.entries[i].is_move() && ok[i]).collect();
        let moved = |i: usize| moved_v[i];

        // dislodgements
        let mut dislodged_by: Vec<Option<usize>> = vec![None; n];
        for i in 0..n {
            if moved(i) {
                continue;
            }
            let p = self.entries[i].province();
            if let Some(list) = self.attackers.get(&p) {
                if let Some(&m) = list.iter().find(|&&m| ok[m]) {
                    dislodged_by[i] = Some(m);
                }
            }
        }

        // standoffs: no move in, at least one failed move in by a unit that was not itself dislodged
        // every PATH is now a function of resolved orders
        let path_ok: Vec<bool> = (0..n)
            .map(|i| self.entries[i].is_move() && self.path_final(i))
            .collect();
        let mut standoffs = BTreeSet::new();
        let attackers: Vec<(ProvinceId, Vec<usize>)> = self
            .attackers
            .iter()
            .map(|(&p, l)| (p, l.clone()))
            .collect();
        for (p, list) in attackers {
            if list.iter().any(|&m| ok[m]) {
                continue;
            }
            let contested = list
                .iter()
                .any(|&m| dislodged_by[m].is_none() && path_ok[m]);
            if !contested {
                continue;
            }
            let occupied_after = self.at.get(&p).map(|&e| !moved(e)).unwrap_or(false);
            if !occupied_after {
                standoffs.insert(p);
            }
        }

        // outcomes
        let mut outcomes = Vec::with_capacity(n);
        for i in 0..n {
            let e = self.entries[i].clone();
            let by = dislodged_by[i].map(|m| self.entries[m].province());
            let outcome = if let Some(reason) = e.illegal {
                OrderOutcome::Illegal {
                    reason,
                    dislodged_by: by,
                }
            } else {
                match e.command {
                    Command::Hold => OrderOutcome::Hold(match by {
                        Some(by) => HoldOutcome::Dislodged { by },
                        None => HoldOutcome::Holds,
                    }),
                    Command::Move { dest, .. } => OrderOutcome::Move(if ok[i] {
                        MoveOutcome::Succeeds
                    } else {
                        self.explain_move(i, dest)
                    }),
                    Command::SupportHold { .. } | Command::SupportMove { .. } => {
                        OrderOutcome::Support(if !self.matched[i] {
                            SupportOutcome::Void
                        } else if let Some(by) = by {
                            SupportOutcome::Dislodged { by }
                        } else if ok[i] {
                            SupportOutcome::Succeeds
                        } else {
                            let p = e.province();
                            let cutter = self
                                .attackers
                                .get(&p)
                                .and_then(|l| {
                                    l.iter().copied().find(|&m| {
                                        self.entries[m].unit.power != e.unit.power && path_ok[m]
                                    })
                                })
                                .map(|m| self.entries[m].province())
                                .unwrap_or(p);
                            SupportOutcome::Cut { by: cutter }
                        })
                    }
                    Command::Convoy { .. } => OrderOutcome::Convoy(if !self.matched[i] {
                        ConvoyOutcome::Void
                    } else if self.paradox[i] {
                        ConvoyOutcome::Paradox
                    } else if let Some(by) = by {
                        ConvoyOutcome::Dislodged { by }
                    } else {
                        ConvoyOutcome::Succeeds
                    }),
                }
            };
            outcomes.push(outcome);
        }

        // which successful moves actually travelled by convoy (matters for retreats, DATC 4.A.5)
        let convoyed: Vec<bool> = (0..n)
            .map(|i| moved(i) && self.convoy_path_final(i))
            .collect();

        // new position
        let mut position = Position::default();
        let mut dislodged = Vec::new();
        for i in 0..n {
            let e = &self.entries[i];
            if moved(i) {
                let region = e.dest_region.expect("legal move has a destination region");
                position.units.push(Unit { region, ..e.unit });
            } else if let Some(m) = dislodged_by[i] {
                dislodged.push(Dislodged {
                    unit: e.unit,
                    attacker_from: self.entries[m].province(),
                    by_convoy: convoyed[m],
                });
            } else {
                position.units.push(e.unit);
            }
        }
        position.units.sort_by_key(|u| u.region);
        dislodged.sort_by_key(|d| d.unit.region);

        let orders: Vec<Order> = self
            .entries
            .iter()
            .map(|e| Order {
                power: e.unit.power,
                unit: e.province(),
                command: e.command,
            })
            .collect();
        MovementResult {
            orders,
            outcomes,
            position,
            dislodged,
            standoffs,
        }
    }

    /// PATH with every order resolved.
    fn path_final(&mut self, i: usize) -> bool {
        self.path(i, true)
    }

    fn explain_move(&mut self, i: usize, dest: ProvinceId) -> MoveOutcome {
        if !self.path_final(i) {
            return MoveOutcome::NoPath;
        }
        let atk = self.attack_strength(i, true);
        let me = self.entries[i].unit.power;
        if let Some(j) = self.h2h(i, true) {
            if atk <= self.defend_strength(j, true) {
                return MoveOutcome::LostHeadToHead {
                    opponent: self.entries[j].province(),
                };
            }
        } else if let Some(&d) = self.at.get(&dest) {
            let stays = !(self.entries[d].is_move() && self.resolved[d] == Some(true));
            if stays && self.entries[d].unit.power == me {
                return MoveOutcome::FriendlyFire;
            }
            if atk <= self.hold_strength(dest, true) {
                return MoveOutcome::Repelled { occupant: dest };
            }
        }
        let competitors = self.attackers.get(&dest).cloned().unwrap_or_default();
        let mut by = Vec::new();
        for k in competitors {
            if k != i && atk <= self.prevent_strength(k, true) {
                by.push(self.entries[k].province());
            }
        }
        if by.is_empty() {
            // only reachable when attack strength is zero for a non-friendly reason
            MoveOutcome::Repelled { occupant: dest }
        } else {
            MoveOutcome::Bounced { by }
        }
    }
}

/// Fleet adjacency between two provinces, considering every coast region of `a`.
fn fleet_adjacent(map: &Map, a: ProvinceId, b: ProvinceId) -> bool {
    map.regions_of(a)
        .into_iter()
        .any(|r| map.adjacent_province(r, UnitKind::Fleet, b))
}

/// Is there any chain of fleet-occupied sea provinces from `origin` to `dest`?
fn convoy_possible(
    map: &Map,
    fleet_seas: &BTreeSet<ProvinceId>,
    origin: ProvinceId,
    dest: ProvinceId,
) -> bool {
    map.is_coastal(origin)
        && map.is_coastal(dest)
        && sea_path_exists(
            map,
            &fleet_seas.iter().copied().collect::<Vec<_>>(),
            origin,
            dest,
        )
}

/// Does `fleet` lie on some *chordless* route through `fleet_seas` from `origin` to `dest`?
///
/// A route is chordless when no fleet on it could be skipped: no element of the chain is
/// adjacent to a later, non-consecutive element (origin and destination included). A fleet
/// that only appears on detours is "not necessary for any convoy route" and its convoy order
/// is illegal (DATC 6.G.19).
fn on_convoy_route(
    map: &Map,
    fleet_seas: &BTreeSet<ProvinceId>,
    origin: ProvinceId,
    dest: ProvinceId,
    fleet: ProvinceId,
) -> bool {
    let seas: Vec<ProvinceId> = fleet_seas.iter().copied().collect();
    let adj = |a: ProvinceId, b: ProvinceId| fleet_adjacent(map, a, b);
    let mut chain = Vec::new();
    chordless_dfs(&seas, &mut chain, origin, dest, fleet, &adj)
}

/// Depth-first enumeration of chordless chains `origin -> s1 -> ... -> sk -> dest`.
fn chordless_dfs(
    seas: &[ProvinceId],
    chain: &mut Vec<ProvinceId>,
    origin: ProvinceId,
    dest: ProvinceId,
    fleet: ProvinceId,
    adj: &dyn Fn(ProvinceId, ProvinceId) -> bool,
) -> bool {
    let last = *chain.last().unwrap_or(&origin);
    // elements strictly before `last` (origin included once the chain has started)
    let earlier: Vec<ProvinceId> = if chain.is_empty() {
        Vec::new()
    } else {
        std::iter::once(origin)
            .chain(chain[..chain.len() - 1].iter().copied())
            .collect()
    };
    if !chain.is_empty() && adj(last, dest) && chain.contains(&fleet) {
        // a fleet before `last` that already touches `dest` makes `last` a detour;
        // the origin touching `dest` is fine (that is a convoy to an adjacent province)
        let detour = chain[..chain.len() - 1].iter().any(|&e| adj(e, dest));
        if !detour {
            return true;
        }
    }
    for &s in seas {
        if chain.contains(&s) || !adj(last, s) || earlier.iter().any(|&e| adj(e, s)) {
            continue;
        }
        chain.push(s);
        let found = chordless_dfs(seas, chain, origin, dest, fleet, adj);
        chain.pop();
        if found {
            return true;
        }
    }
    false
}

/// Sea provinces (subset of `seas`) reachable from coastal `start` by fleet adjacency through `seas`.
fn reachable_seas(map: &Map, seas: &[ProvinceId], start: ProvinceId) -> BTreeSet<ProvinceId> {
    let mut seen = BTreeSet::new();
    let mut queue: VecDeque<ProvinceId> = seas
        .iter()
        .copied()
        .filter(|&s| fleet_adjacent(map, s, start))
        .collect();
    while let Some(s) = queue.pop_front() {
        if !seen.insert(s) {
            continue;
        }
        for &t in seas {
            if !seen.contains(&t) && map.adjacent(Region::land(s), UnitKind::Fleet, Region::land(t))
            {
                queue.push_back(t);
            }
        }
    }
    seen
}

fn sea_path_exists(map: &Map, seas: &[ProvinceId], origin: ProvinceId, dest: ProvinceId) -> bool {
    if seas.is_empty() || origin == dest {
        return false;
    }
    reachable_seas(map, seas, origin)
        .iter()
        .any(|&s| fleet_adjacent(map, s, dest))
}
