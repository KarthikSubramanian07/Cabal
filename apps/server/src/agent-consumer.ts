/**
 * Queue consumer for Claude seats.
 *
 * A message is one turn for one AI seat in one phase. The consumer asks the room for a brief,
 * asks Claude for a decision and hands it back, all over the Durable Object binding: there are no
 * agent tokens, and nothing here is reachable from the internet.
 *
 * It can never hold a game up or run a bill up. The room has already put the bot's orders on file
 * and stops waiting after a fixed time, the room caps Claude turns per game, a turn for a phase
 * that has moved on is dropped before the model is called, and a message is never retried after
 * the model has been called, so one turn costs at most one request.
 */
import { type Brain, ClaudeBrain, PERSONAS, Player } from "@cabal/agents";
import type { PowerName } from "@cabal/protocol";
import { Game, engineReady, mapInfo } from "./engine.js";
import type { AgentTurn, Env } from "./env.js";

/** The model behind Claude seats. */
export const CLAUDE_MODEL = "claude-opus-5-5";

/**
 * The room stops waiting for a seat after 90 seconds, so a request that runs longer is wasted:
 * time out before that, and never retry inside the SDK (one turn is one request).
 */
export const CLAUDE_TIMEOUT_MS = 75_000;

/** Replaceable in tests, so the suite never calls the real API. Null means "no model configured". */
export const agentRuntime: { makeBrain: (env: Env, turn: AgentTurn) => Brain | null } = {
  makeBrain: (env) =>
    env.ANTHROPIC_API_KEY
      ? new ClaudeBrain({ apiKey: env.ANTHROPIC_API_KEY, model: CLAUDE_MODEL, timeoutMs: CLAUDE_TIMEOUT_MS, maxRetries: 0 })
      : null,
};

function log(event: string, fields: Record<string, unknown>, level: "info" | "error" = "info"): void {
  const line = JSON.stringify({ event, ...fields });
  if (level === "error") console.error(line);
  else console.info(line);
}

/** Play one turn. Resolves to what happened; throws only before the model has been called. */
export async function playTurn(turn: AgentTurn, env: Env): Promise<string> {
  const power = turn.power as PowerName;
  const room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(turn.gameId));
  const brief = await room.agentBrief(power, turn.phase);
  if (!brief) return "stale";
  const brain = agentRuntime.makeBrain(env, turn);
  if (!brain) {
    await room.agentSubmit(power, turn.phase, null);
    return "no_model";
  }
  try {
    await engineReady();
    const game = Game.fromState(brief.state);
    let legal: ReturnType<Game["legal"]>;
    try {
      legal = game.legal(power);
    } finally {
      game.free();
    }
    const player = new Player(power, PERSONAS[power] ?? "A careful strategist.", brain);
    const { decision, validated, fallback } = await player.play({
      phase: brief.phase,
      state: brief.state,
      map: mapInfo(),
      legal,
      press: brief.press.map((item) => ({ from: item.from, to: item.to, body: item.body, pledge: item.pledge?.orders ?? null })),
      myPledges: brief.press.filter((item) => item.from === power && item.pledge?.orders).map((item) => item.pledge!.orders!),
      trust: brief.trust,
    });
    // The model failed or refused: the bot's orders, already on file, are better than random ones.
    const result = await room.agentSubmit(
      power,
      turn.phase,
      fallback ? null : { orders: validated.orders, messages: decision.messages, pledge: decision.pledge },
    );
    return fallback ? "model_failed" : result.reason;
  } catch (error) {
    // The model may already have been paid for. Close the turn with the bot's orders; never retry.
    log("agent_turn_failed", { ...turn, error: String(error) }, "error");
    await room.agentSubmit(power, turn.phase, null).catch(() => undefined);
    return "failed";
  }
}

export async function consumeTurns(batch: MessageBatch<AgentTurn>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const outcome = await playTurn(message.body, env);
      log("agent_turn", { ...message.body, outcome });
      message.ack();
    } catch (error) {
      // Only reachable before the model call (the room could not be reached): safe to retry.
      log("agent_turn_retry", { ...message.body, error: String(error) }, "error");
      message.retry({ delaySeconds: 10 });
    }
  }
}
