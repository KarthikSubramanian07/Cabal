/**
 * Queue consumer for Claude seats.
 *
 * A message is one step of one turn for one AI seat: one model call. The consumer asks the room
 * for a brief, asks Claude for a decision and hands it back with what it cost, all over the
 * Durable Object binding: there are no agent tokens, and nothing here is reachable from the
 * internet.
 *
 * It can never hold a game up or run a bill up:
 *
 *  - the room has already put the bot's orders on file and stops waiting after a fixed time;
 *  - the room reserved the worst-case price of this call against the game's spend cap before it
 *    queued the message, and settles the real price from the API's usage report;
 *  - a brief is handed out once, so a message delivered twice is one model call, and a message for
 *    a phase or a step that has moved on is acknowledged and dropped before the model is called;
 *  - the SDK does not retry and neither does the queue: once the room has answered, the message
 *    is acknowledged whatever happens next. A request the API rejects fails once, not six times.
 */
import { type Brain, BrainFailure, ClaudeBrain, PERSONAS, Player } from "@cabal/agents";
import type { PowerName } from "@cabal/protocol";
import { Game, engineReady, mapInfo } from "./engine.js";
import type { AgentTurn, Env } from "./env.js";
import { currentRequestId, log, requestIdFrom, withLogContext } from "./log.js";
import { type AgentReport, CLAUDE_MODEL } from "./room.js";

export { CLAUDE_MODEL };

/**
 * The room stops waiting for a seat after 90 seconds (60 for the talks), so a request that runs
 * longer is wasted: time out before that, and never retry inside the SDK (one step is one request).
 */
export const CLAUDE_TIMEOUT_MS = { negotiate: 50_000, order: 75_000 } as const;

/** Replaceable in tests, so the suite never calls the real API. Null means "no model configured". */
export const agentRuntime: { makeBrain: (env: Env, turn: AgentTurn) => Brain | null } = {
  makeBrain: (env, turn) =>
    env.ANTHROPIC_API_KEY
      ? new ClaudeBrain({ apiKey: env.ANTHROPIC_API_KEY, model: CLAUDE_MODEL, timeoutMs: CLAUDE_TIMEOUT_MS[turn.step], maxRetries: 0 })
      : null,
};


const UNBILLED: AgentReport = { model: null, usage: null, billed: "no" };

/**
 * Play one step. Resolves to what happened. Throws only when the room could not be reached for
 * the brief, which is before anything was claimed or paid for and so is the one safe retry.
 */
export async function playTurn(turn: AgentTurn, env: Env): Promise<string> {
  const power = turn.power as PowerName;
  const step = turn.step ?? "order";
  const room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(turn.gameId));
  const brief = await room.agentBrief(power, turn.phase, step, currentRequestId());
  if (!brief) return "stale";
  // From here on the step is claimed: every path must close it with the room, and none may retry.
  let report: AgentReport = { ...UNBILLED };
  try {
    const brain = agentRuntime.makeBrain(env, turn);
    if (!brain) {
      await room.agentSubmit(power, turn.phase, step, null, UNBILLED, currentRequestId());
      return "no_model";
    }
    await engineReady();
    const game = Game.fromState(brief.state);
    let legal: ReturnType<Game["legal"]>;
    try {
      legal = game.legal(power);
    } finally {
      game.free();
    }
    const player = new Player(power, PERSONAS[power] ?? "A careful strategist.", brain, brief.memory);
    const played = await player.play({
      phase: brief.phase,
      step,
      state: brief.state,
      map: mapInfo(),
      legal,
      press: brief.press.map((item) => ({ from: item.from, to: item.to, body: item.body, pledge: item.pledge?.orders ?? null })),
      earlierPress: brief.earlierPress,
      myPledges: brief.press.filter((item) => item.from === power && item.pledge?.orders).map((item) => item.pledge!.orders!),
      trust: brief.trust,
    });
    report = {
      model: played.model,
      usage: played.usage,
      billed: played.failure ? played.failure.billed : played.usage ? "yes" : "no",
      failure: played.failure ? { status: played.failure.status, message: played.failure.message } : null,
      memory: played.fallback ? null : player.memory(),
    };
    // The model failed or refused: the bot's orders, already on file, are better than holding.
    const outcome = await room.agentSubmit(
      power,
      turn.phase,
      step,
      played.fallback ? null : { orders: played.validated.orders, messages: played.decision.messages, pledge: played.decision.pledge },
      report,
      currentRequestId(),
    );
    if (played.failure) log("agent_model_failed", { ...turn, status: played.failure.status, billed: played.failure.billed, error: played.failure.message }, "error");
    return played.fallback ? "model_failed" : outcome.reason;
  } catch (error) {
    // Something broke after the claim. Close the step with whatever is known about its cost: if
    // the model was never reached that is nothing, and if it was the room charges for it.
    log("agent_turn_failed", { ...turn, error: String(error) }, "error");
    const known: AgentReport = report.billed === "no" && error instanceof BrainFailure ? { model: error.model, usage: error.usage, billed: error.billed } : report;
    await room.agentSubmit(power, turn.phase, step, null, { ...known, failure: { status: null, message: String(error) } }, currentRequestId()).catch(() => undefined);
    return "failed";
  }
}

export async function consumeTurns(batch: MessageBatch<AgentTurn>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    // One message, one id: the room's lines about this turn carry it too.
    await withLogContext({ service: "queue", requestId: requestIdFrom(`q-${message.id}`, "q") }, async () => {
      try {
        const outcome = await playTurn(message.body, env);
        log("agent_turn", { ...message.body, outcome });
        message.ack();
      } catch (error) {
        // Only reachable before the brief was claimed (the room could not be reached): safe to retry,
        // and the queue's max_retries bounds it. After that the dead-letter queue has the message.
        log("agent_turn_retry", { ...message.body, attempts: message.attempts, error: String(error) }, "error");
        message.retry({ delaySeconds: 10 });
      }
    });
  }
}
