/**
 * @cabal/protocol: the wire protocol between clients, agents and the GameRoom.
 *
 * Every WebSocket frame is a JSON envelope `{ t, id?, p }` validated with the
 * schemas below. Order text is MILA notation. Powers are full upper case names.
 * See docs/PROTOCOL.md for the narrative version.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

// ---------- primitives ----------

export const PowerName = z.enum([
  "AUSTRIA",
  "ENGLAND",
  "FRANCE",
  "GERMANY",
  "ITALY",
  "RUSSIA",
  "TURKEY",
]);
export type PowerName = z.infer<typeof PowerName>;

/** `S1901M`, `F1901R`, `W1901A` or `COMPLETED`. */
export const PhaseName = z
  .string()
  .regex(/^([SF]\d{4}[MR]|W\d{4}A|COMPLETED)$/, "phase name");
export type PhaseName = z.infer<typeof PhaseName>;

export const OrderText = z.string().trim().min(3).max(64);

export const Recipient = z.union([PowerName, z.literal("ALL")]);
export type Recipient = z.infer<typeof Recipient>;

export const PressMode = z.enum(["full", "public", "gunboat"]);
export type PressMode = z.infer<typeof PressMode>;

export const Pacing = z.enum(["live", "daily", "async"]);
export type Pacing = z.infer<typeof Pacing>;

export const SeatKind = z.enum(["human", "ai", "open", "civil_disorder"]);
export type SeatKind = z.infer<typeof SeatKind>;

/** Lobby settings that define a game. Also the rating cluster key. */
export const GameSettings = z.object({
  variant: z.literal("standard").default("standard"),
  rulebook: z.enum(["2023", "1982", "1971", "dptg"]).default("2023"),
  press: PressMode.default("full"),
  pacing: Pacing.default("async"),
  /** Movement phase length in seconds. */
  movementSeconds: z.number().int().min(60).max(14 * 24 * 3600).default(24 * 3600),
  /** Retreat and adjustment phase length in seconds. */
  shortPhaseSeconds: z.number().int().min(30).max(7 * 24 * 3600).default(12 * 3600),
  /** Advance as soon as every seat is ready. */
  readyAdvance: z.boolean().default(true),
  dias: z.boolean().default(true),
  ghostVotes: z.boolean().default(true),
  /** Optional Cabal layer: secretly deal players into cabals with a shared objective. */
  cabals: z.boolean().default(false),
  /** Fill empty seats with AI players when the host starts the game. */
  aiFill: z.boolean().default(true),
});
export type GameSettings = z.infer<typeof GameSettings>;

// ---------- pledges ----------

/** A sealed or open commitment to specific orders, attached to a press message. */
export const PledgeInput = z.object({
  /** Canonical MILA orders the sender commits to for the current phase. */
  orders: z.array(OrderText).min(1).max(34),
  /** Sealed: recipients see only the commitment until the phase resolves. */
  sealed: z.boolean().default(false),
  /** 16 byte hex nonce chosen by the sender (required when sealed). */
  nonce: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});
export type PledgeInput = z.infer<typeof PledgeInput>;

export const Receipt = z.enum(["kept", "broken", "void"]);
export type Receipt = z.infer<typeof Receipt>;

export const PledgeView = z.object({
  id: z.string(),
  pledger: PowerName,
  audience: Recipient,
  phase: PhaseName,
  sealed: z.boolean(),
  /** BLAKE3 hex commitment (always present). */
  commitment: z.string(),
  /** Orders, visible to the audience of an open pledge, or to everyone after reveal. */
  orders: z.array(OrderText).nullable(),
  receipt: Receipt.nullable(),
});
export type PledgeView = z.infer<typeof PledgeView>;

// ---------- shared views ----------

export const SeatView = z.object({
  power: PowerName,
  kind: SeatKind,
  /** Display name; null for open seats. */
  name: z.string().nullable(),
  ready: z.boolean(),
  eliminated: z.boolean(),
  /** Consecutive missed phases. */
  missed: z.number().int().min(0),
});
export type SeatView = z.infer<typeof SeatView>;

/** Board state in MILA layout (mirrors the engine's `State`). */
export const StateView = z.object({
  name: PhaseName,
  units: z.record(z.string(), z.array(z.string())),
  centers: z.record(z.string(), z.array(z.string())),
  homes: z.record(z.string(), z.array(z.string())),
  retreats: z.record(z.string(), z.record(z.string(), z.array(z.string()))),
  builds: z.record(z.string(), z.object({ count: z.number().int(), homes: z.array(z.string()) })),
});
export type StateView = z.infer<typeof StateView>;

export const OrderResultView = z.object({
  power: z.string(),
  unit: z.string(),
  order: z.string(),
  ok: z.boolean(),
  code: z.string(),
  reason: z.string(),
});
export type OrderResultView = z.infer<typeof OrderResultView>;

export const PressView = z.object({
  id: z.string(),
  phase: PhaseName,
  from: PowerName,
  to: Recipient,
  body: z.string(),
  sentAt: z.number().int(),
  pledge: PledgeView.nullable(),
});
export type PressView = z.infer<typeof PressView>;

// ---------- client -> server ----------

export const ClientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), id: z.string().optional(), p: z.object({ token: z.string() }) }),
  z.object({
    t: z.literal("orders.set"),
    id: z.string().optional(),
    p: z.object({ phase: PhaseName, orders: z.array(OrderText).max(34) }),
  }),
  z.object({
    t: z.literal("orders.default"),
    id: z.string().optional(),
    p: z.object({ orders: z.array(OrderText).max(34) }),
  }),
  z.object({
    t: z.literal("ready"),
    id: z.string().optional(),
    p: z.object({ phase: PhaseName, ready: z.boolean() }),
  }),
  z.object({
    t: z.literal("press.send"),
    id: z.string().optional(),
    p: z.object({
      to: Recipient,
      body: z.string().trim().min(1).max(4000),
      pledge: PledgeInput.optional(),
    }),
  }),
  z.object({
    t: z.literal("vote"),
    id: z.string().optional(),
    p: z.object({ kind: z.literal("draw"), value: z.boolean() }),
  }),
  z.object({
    t: z.literal("sync"),
    id: z.string().optional(),
    p: z.object({ since: z.number().int().min(0) }),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------- server -> client ----------

export const GameStatus = z.enum(["lobby", "active", "finished"]);
export type GameStatus = z.infer<typeof GameStatus>;

export const ServerMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"),
    id: z.string().optional(),
    p: z.object({
      gameId: z.string(),
      settings: GameSettings,
      status: GameStatus,
      power: PowerName.nullable(),
      phase: PhaseName,
      state: StateView,
      seats: z.array(SeatView),
      deadlineAt: z.number().int().nullable(),
      seq: z.number().int(),
      orders: z.array(OrderText),
      press: z.array(PressView),
    }),
  }),
  z.object({
    t: z.literal("state"),
    p: z.object({ phase: PhaseName, state: StateView, deadlineAt: z.number().int().nullable(), seq: z.number().int() }),
  }),
  z.object({
    t: z.literal("results"),
    p: z.object({
      phase: PhaseName,
      results: z.array(OrderResultView),
      dislodged: z.array(z.object({ unit: z.string(), attacker_from: z.string(), retreat_options: z.array(z.string()) })),
      standoffs: z.array(z.string()),
      civil_disorder: z.array(z.string()),
      seq: z.number().int(),
    }),
  }),
  z.object({
    t: z.literal("orders.ack"),
    id: z.string().optional(),
    p: z.object({
      phase: PhaseName,
      accepted: z.array(OrderText),
      rejected: z.array(z.object({ text: z.string(), reason: z.string() })),
    }),
  }),
  z.object({ t: z.literal("press"), id: z.string().optional(), p: PressView }),
  z.object({
    t: z.literal("pledge.receipt"),
    p: z.object({ pledgeId: z.string(), receipt: Receipt, revealed: z.array(OrderText).nullable() }),
  }),
  z.object({ t: z.literal("seats"), p: z.object({ seats: z.array(SeatView) }) }),
  z.object({ t: z.literal("deadline"), p: z.object({ phase: PhaseName, deadlineAt: z.number().int().nullable() }) }),
  z.object({
    t: z.literal("finished"),
    p: z.object({
      result: z.enum(["solo", "draw"]),
      winners: z.array(PowerName),
      scores: z.record(z.string(), z.number()),
    }),
  }),
  z.object({ t: z.literal("error"), id: z.string().optional(), p: z.object({ code: z.string(), message: z.string() }) }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---------- HTTP ----------

export const CreateGameRequest = z.object({
  settings: GameSettings.partial().default({}),
  /** Display name of the creator. */
  name: z.string().trim().min(1).max(32),
});
export type CreateGameRequest = z.infer<typeof CreateGameRequest>;

export const CreateGameResponse = z.object({ gameId: z.string(), token: z.string(), power: PowerName });
export type CreateGameResponse = z.infer<typeof CreateGameResponse>;

export const JoinGameRequest = z.object({
  name: z.string().trim().min(1).max(32),
  /** Preferred power; the server assigns one when absent or taken. */
  power: PowerName.optional(),
});
export type JoinGameRequest = z.infer<typeof JoinGameRequest>;

export const JoinGameResponse = CreateGameResponse;
export type JoinGameResponse = z.infer<typeof JoinGameResponse>;

// ---------- scoring ----------

/** Sum of Squares share of a draw for each surviving power. */
export function sumOfSquares(centers: Record<string, number>): Record<string, number> {
  const total = Object.values(centers).reduce((a, c) => a + c * c, 0);
  const out: Record<string, number> = {};
  for (const [power, c] of Object.entries(centers)) {
    out[power] = total === 0 ? 0 : (c * c) / total;
  }
  return out;
}

/** Draw Size Scoring: equal shares among survivors. */
export function drawSize(centers: Record<string, number>): Record<string, number> {
  const survivors = Object.entries(centers).filter(([, c]) => c > 0);
  const out: Record<string, number> = {};
  for (const [power] of Object.entries(centers)) {
    out[power] = 0;
  }
  for (const [power] of survivors) {
    out[power] = 1 / survivors.length;
  }
  return out;
}

/** Parse and validate one client frame. Returns null for anything that does not validate. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  const r = ClientMessage.safeParse(raw);
  return r.success ? r.data : null;
}

/** The rating cluster a game belongs to: only like settings are compared. */
export function ratingCluster(s: GameSettings): string {
  return `${s.variant}:${s.press}:${s.pacing}`;
}
