/**
 * Spend caps for model-backed seats, and the stand-in that takes over when one is reached.
 *
 * A cap is hard: before a call, the worst case it could cost (every input token written to the
 * cache, the whole output allowance spent; see `maxCallCostMicros`) is reserved against every cap
 * the call is under, and the call is refused when any of them cannot cover it. After the call the
 * reservation is replaced by what the API reported. A call whose cost is unknown (a timeout, a
 * dropped connection) keeps its whole reservation, so the cap can only err on the safe side.
 *
 * The usual arrangement is a cap per seat under one cap for the whole run:
 *
 *   new FailoverBrain(new CappedBrain(claude, "claude-opus-5-5", [seatCap, runCap]), bot)
 *
 * A refused or failed call then costs nothing more and the seat plays the bot's orders. Without the
 * failover, `Player` holds every unit instead.
 */
import { type Usage, costMicros, maxCallCostMicros } from "./cost.js";
import { type Brain, BrainFailure, type BrainReply, type BrainRequest, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, requestKind } from "./player.js";

export class SpendCap {
  private spent = 0;
  private held = 0;

  /** `capMicros` is the most this cap will ever let through, in micro-dollars. */
  constructor(
    readonly capMicros: number,
    readonly label = "spend cap",
  ) {
    if (!Number.isFinite(capMicros) || capMicros < 0) throw new RangeError(`${label} must be a non-negative number of micro-dollars`);
  }

  /** Settled spend, in micro-dollars. */
  spentMicros(): number {
    return this.spent;
  }

  /** What is still free: the cap less what is spent and what is reserved for calls in flight. */
  leftMicros(): number {
    return this.capMicros - this.spent - this.held;
  }

  /** Hold `micros` for a call, or return false and hold nothing. */
  reserve(micros: number): boolean {
    if (micros > this.leftMicros()) return false;
    this.held += micros;
    return true;
  }

  /** Release a reservation and charge what the call really cost (never more than was held). */
  settle(reservedMicros: number, actualMicros: number): void {
    this.held -= reservedMicros;
    this.spent += Math.min(reservedMicros, Math.max(0, actualMicros));
  }
}

/** A model brain that never runs past its caps. */
export class CappedBrain implements Brain {
  constructor(
    private inner: Brain,
    /** The model `inner` calls, for the worst-case price. */
    readonly model: string,
    private caps: SpendCap[],
  ) {}

  async decide(request: BrainRequest): Promise<BrainReply> {
    const worst = maxCallCostMicros(this.model, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS[requestKind(request.kind, request.step)]);
    const taken: SpendCap[] = [];
    for (const cap of this.caps) {
      if (!cap.reserve(worst)) {
        for (const t of taken) t.settle(worst, 0);
        throw new BrainFailure(`${cap.label} reached: ${cap.leftMicros()} micro-dollars left, a call may cost ${worst}`, "no", null, this.model);
      }
      taken.push(cap);
    }
    let charge = worst;
    try {
      const reply = await this.inner.decide(request);
      charge = reply.usage ? costMicros(reply.model ?? this.model, reply.usage) : 0;
      return reply;
    } catch (error) {
      if (error instanceof BrainFailure) charge = error.usage ? costMicros(error.model ?? this.model, error.usage) : error.billed === "no" ? 0 : worst;
      throw error;
    } finally {
      for (const cap of taken) cap.settle(worst, charge);
    }
  }
}

/**
 * Ask `primary`; when it fails, ask `backup` and say so. The reply carries the failed attempt's
 * usage, so a player's bill still counts it. A failing backup fails the turn (the player holds).
 */
export class FailoverBrain implements Brain {
  constructor(
    private primary: Brain,
    private backup: Brain,
  ) {}

  async decide(request: BrainRequest): Promise<BrainReply> {
    try {
      return await this.primary.decide(request);
    } catch (error) {
      const failure = error instanceof BrainFailure ? error : null;
      const reply = await this.backup.decide(request);
      const usage: Usage | null = failure?.usage ?? null;
      return {
        ...reply,
        failover: { reason: error instanceof Error ? error.message : String(error), usage, model: failure?.model ?? null },
      };
    }
  }
}
