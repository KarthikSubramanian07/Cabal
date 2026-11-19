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

/**
 * Puts a game back as it was from the text taken before a write that then failed.
 *
 * The text is the room's own record, so it is resumed, never replayed: `resume` adjudicates
 * nothing from the past. Replaying here (`fromSaved`) would throw for any game whose history
 * holds a ruling the engine has since corrected, inside the very catch block that is meant to
 * recover, and leave the room holding an engine that is ahead of its storage.
 */
export function restoreGame<G>(engine: { resume(saved: string, rulebook?: string): G }, saved: string, rulebook: string): G {
  return engine.resume(saved, rulebook);
}
