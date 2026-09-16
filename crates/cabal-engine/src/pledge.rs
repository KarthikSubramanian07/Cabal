//! Seals: cryptographic commitments to orders, and their receipts.
//!
//! A *seal* is a BLAKE3 commitment over a canonical order list plus a nonce.
//! After adjudication the pledged orders are compared with what the pledger
//! actually submitted and a *receipt* (`Kept`, `Broken`, `Void`) is issued.
//! Everything here is pure, so any client can recompute a receipt from a replay.

use serde::{Deserialize, Serialize};

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

/// Compare pledged orders with the orders actually submitted in that phase.
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
}
