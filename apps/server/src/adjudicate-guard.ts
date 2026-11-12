// Runs engine normalisation and adjudication. If normalisation or adjudication
// throws, the error is reported and rethrown. The caller must never fall back to
// holding every unit: a phase we cannot adjudicate has to stall visibly.
export interface AdjudicationEngine<I, O> {
  normaliseOrders(input: I): I;
  process(input: I): O;
}

export function adjudicateStrict<I, O>(
  game: AdjudicationEngine<I, O>,
  input: I,
  report: (error: unknown) => void,
): O {
  try {
    return game.process(game.normaliseOrders(input));
  } catch (error) {
    report(error);
    throw error;
  }
}
