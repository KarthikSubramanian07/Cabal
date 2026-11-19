//! A tiny, portable pseudo random generator.
//!
//! SplitMix64: integer only, so a seed gives the same stream natively and in
//! WebAssembly. Nothing here is cryptographic.

#[derive(Clone, Debug)]
pub(crate) struct Rng(u64);

/// One SplitMix64 step: also a good 64 bit mixer for combining seed parts.
pub(crate) fn mix(a: u64, b: u64) -> u64 {
    let mut z = a
        .wrapping_add(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(b.wrapping_mul(0xD6E8_FEB8_6659_FD93));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    pub(crate) fn new(seed: u64) -> Self {
        Rng(seed)
    }

    pub(crate) fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n` (`0` when `n` is zero).
    pub(crate) fn below(&mut self, n: u32) -> u32 {
        (((self.next() >> 32) * u64::from(n)) >> 32) as u32
    }

    /// Uniform in `-amp..=amp`.
    pub(crate) fn spread(&mut self, amp: i32) -> i32 {
        if amp <= 0 {
            0
        } else {
            self.below(2 * amp as u32 + 1) as i32 - amp
        }
    }

    pub(crate) fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.below(i as u32 + 1) as usize;
            items.swap(i, j);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_is_stable_and_bounded() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        for _ in 0..1000 {
            let x = a.below(13);
            assert_eq!(x, b.below(13));
            assert!(x < 13);
            let s = a.spread(5);
            assert_eq!(s, b.spread(5));
            assert!((-5..=5).contains(&s));
        }
        assert_eq!(Rng::new(1).below(0), 0);
        assert_eq!(Rng::new(1).spread(0), 0);
        // pinned: a change here silently changes every bot decision ever replayed
        assert_eq!(Rng::new(42).next(), 13_679_457_532_755_275_413);
        assert_ne!(mix(1, 2), mix(2, 1));
    }

    #[test]
    fn shuffle_is_a_permutation() {
        let mut v: Vec<u32> = (0..20).collect();
        Rng::new(3).shuffle(&mut v);
        let mut s = v.clone();
        s.sort();
        assert_eq!(s, (0..20).collect::<Vec<_>>());
        assert_ne!(v, s);
    }
}
