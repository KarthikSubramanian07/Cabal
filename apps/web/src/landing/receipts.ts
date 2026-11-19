/**
 * The example Ledger page on the front door: three receipts from a made-up Fall 1902. Kept apart
 * from the page so a test can check every order against the engine: a site that sells rules you
 * can check must not print an order a Diplomacy player knows is impossible.
 */
export interface ExampleReceipt {
  who: string;
  /** The pledging power, as the engine names it. */
  power: string;
  order: string;
  stamp: "kept" | "broken" | "void";
}

export const EXAMPLE_RECEIPTS: readonly ExampleReceipt[] = [
  { who: "Italy to Austria", power: "ITALY", order: "A VEN H", stamp: "kept" },
  // The Black Sea stays empty: the oldest promise between Russia and Turkey, and the most broken.
  { who: "Russia to Turkey", power: "RUSSIA", order: "F SEV H", stamp: "broken" },
  { who: "Germany to all", power: "GERMANY", order: "A MUN S A BER", stamp: "void" },
];
