/**
 * How many adjudication test cases the engine passes, for every page that says so. The counts
 * live in adjudication.json (the build script that writes the static pages reads the same file),
 * and adjudication.test.ts holds them to the fixtures the Rust tests run:
 * crates/cabal-engine/tests/data/datc_v3.json and cabal_cases.json.
 */
import counts from "./adjudication.json";

/** The Diplomacy Adjudicator Test Cases, v3.0. */
export const DATC_CASES: number = counts.datc;
/** Cabal's own cases: rulings that follow from the rulebook and that the DATC layout cannot express. */
export const CABAL_CASES: number = counts.cabal;
/** Every case `cabal datc` adjudicates; its last line reads `total: <this> passed`. */
export const ADJUDICATION_CASES: number = DATC_CASES + CABAL_CASES;

/** The footer's sentence, shared with the static pages in scripts/emit-agent-site.mjs. */
export const ENGINE_CLAIM = `Adjudicated in your browser by a Rust engine that passes all ${ADJUDICATION_CASES} DATC and Cabal test cases.`;
