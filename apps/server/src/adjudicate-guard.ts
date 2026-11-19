// Runs engine normalisation and adjudication. If either throws, the error is reported and
// rethrown: this helper never invents an outcome. The room decides what happens next: it rolls
// the phase back, retries on a short bounded backoff, and only then resolves the phase with every
// unit holding, so a broken phase is loud but can never freeze a game.
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
