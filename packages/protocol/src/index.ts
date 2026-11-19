/**
 * @cabal/protocol: the wire protocol between clients, agents and the GameRoom.
 *
 * Every WebSocket frame is a JSON envelope `{ t, id?, p }` validated with the
 * schemas below. Order text is MILA notation. Powers are full upper case names.
 * See docs/PROTOCOL.md for the narrative version.
 */
import { z } from "zod";

/**
 * Bumped when a frame changes meaning. Version 2: every broadcast frame carries its own `seq` on
 * the envelope, and `sync { since }` replays the frames after that number.
 */
export const PROTOCOL_VERSION = 2 as const;

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

export const AiBrain = z.enum(["bot", "claude"]);
export type AiBrain = z.infer<typeof AiBrain>;

/** How a draw is scored: Sum of Squares (centre counts squared) or Draw Size (equal shares). */
export const Scoring = z.enum(["sos", "dss"]);
export type Scoring = z.infer<typeof Scoring>;

/** `public` games appear in `GET /api/games`; `unlisted` games are reachable only by their code. */
export const Visibility = z.enum(["public", "unlisted"]);
export type Visibility = z.infer<typeof Visibility>;

/**
 * Clock presets per pacing. A game that names a pacing and no explicit seconds gets these.
 * `grace` is the one-off allowance granted at the deadline when a player has still not moved;
 * `extend` is what a granted extension adds.
 */
export const PACING_PRESETS = {
  live: { movementSeconds: 600, shortPhaseSeconds: 300, graceSeconds: 60, extendSeconds: 300 },
  daily: { movementSeconds: 86_400, shortPhaseSeconds: 43_200, graceSeconds: 600, extendSeconds: 43_200 },
  async: { movementSeconds: 172_800, shortPhaseSeconds: 86_400, graceSeconds: 900, extendSeconds: 86_400 },
} as const satisfies Record<Pacing, Record<string, number>>;

/** The bare validators for each setting, shared by the stored form and the lobby's partial form. */
const settingsShape = {
  variant: z.literal("standard"),
  rulebook: z.enum(["2023", "1982", "1971", "dptg"]),
  press: PressMode,
  pacing: Pacing,
  /** Movement phase length in seconds. Filled from the pacing preset when absent (see `resolveSettings`). */
  movementSeconds: z.number().int().min(60).max(14 * 24 * 3600),
  /** Retreat and adjustment phase length in seconds. */
  shortPhaseSeconds: z.number().int().min(30).max(7 * 24 * 3600),
  /**
   * Grace period: when the deadline arrives and a player who can act has sent nothing, the phase
   * waits this much longer, once. It is never added to a deadline everybody has met. 0 disables it.
   */
  graceSeconds: z.number().int().min(0).max(3600),
  /** Seconds a granted extension adds to the current deadline. */
  extendSeconds: z.number().int().min(30).max(24 * 3600),
  /** Private messages one power may send per phase; `null` is unlimited. */
  whisperBudget: z.number().int().min(0).max(60).nullable(),
  /** Rulebook press: no press during retreat and adjustment phases. */
  rulebookPress: z.boolean(),
  /** Advance as soon as every seat that can act is ready. */
  readyAdvance: z.boolean(),
  /** Draws Include All Survivors. When false a draw may name a subset, agreed by every voter. */
  dias: z.boolean(),
  /** Eliminated players may cast a visible, advisory draw vote. They are never required and never veto. */
  ghostVotes: z.boolean(),
  /** Optional Cabal layer: secretly deal players into cabals with a shared objective. */
  cabals: z.boolean(),
  /** Fill empty seats with AI players when the host starts, and cover seats that fall into civil disorder. */
  aiFill: z.boolean(),
  /** Who plays AI seats: the built-in bot (free, instant) or Claude (opt-in, capped, falls back to the bot). */
  aiBrain: AiBrain,
  /** How a draw is shared out. A solo is always 1 to the winner. */
  scoring: Scoring,
  /** Whether the game is listed while it is open or running. */
  visibility: Visibility,
  /** True: every draw vote is shown with its voter. False: only the tally is shown, and a voter sees their own. */
  publicVotes: z.boolean(),
};

/** Lobby settings that define a game. Also the rating cluster key. */
export const GameSettings = z.object({
  variant: settingsShape.variant.default("standard"),
  rulebook: settingsShape.rulebook.default("2023"),
  press: settingsShape.press.default("full"),
  pacing: settingsShape.pacing.default("async"),
  movementSeconds: settingsShape.movementSeconds.default(PACING_PRESETS.async.movementSeconds),
  shortPhaseSeconds: settingsShape.shortPhaseSeconds.default(PACING_PRESETS.async.shortPhaseSeconds),
  graceSeconds: settingsShape.graceSeconds.default(PACING_PRESETS.async.graceSeconds),
  extendSeconds: settingsShape.extendSeconds.default(PACING_PRESETS.async.extendSeconds),
  whisperBudget: settingsShape.whisperBudget.default(null),
  rulebookPress: settingsShape.rulebookPress.default(false),
  readyAdvance: settingsShape.readyAdvance.default(true),
  dias: settingsShape.dias.default(true),
  ghostVotes: settingsShape.ghostVotes.default(true),
  cabals: settingsShape.cabals.default(false),
  aiFill: settingsShape.aiFill.default(true),
  aiBrain: settingsShape.aiBrain.default("bot"),
  scoring: settingsShape.scoring.default("sos"),
  visibility: settingsShape.visibility.default("unlisted"),
  publicVotes: settingsShape.publicVotes.default(true),
});
export type GameSettings = z.infer<typeof GameSettings>;

/** What a lobby sends: any subset of the settings, with nothing filled in. Unknown keys are dropped. */
export const GameSettingsInput = z.object(settingsShape).partial();
export type GameSettingsInput = z.infer<typeof GameSettingsInput>;

/**
 * Turn a lobby's partial settings into full settings. Clock fields the caller left out come from
 * the pacing preset; anything the caller did send wins. Throws a ZodError on bad input.
 */
export function resolveSettings(input: GameSettingsInput = {}): GameSettings {
  const partial = GameSettingsInput.parse(input);
  const preset = PACING_PRESETS[partial.pacing ?? "async"];
  return GameSettings.parse({
    ...partial,
    movementSeconds: partial.movementSeconds ?? preset.movementSeconds,
    shortPhaseSeconds: partial.shortPhaseSeconds ?? preset.shortPhaseSeconds,
    graceSeconds: partial.graceSeconds ?? preset.graceSeconds,
    extendSeconds: partial.extendSeconds ?? preset.extendSeconds,
  });
}

// ---------- pledges ----------

/** A sealed or open commitment to specific orders, attached to a press message. */
export const PledgeInput = z.object({
  /** Canonical MILA orders the sender commits to for the current phase. */
  orders: z.array(OrderText).min(1).max(34),
  /** Sealed: recipients see only the commitment until the phase resolves. */
  sealed: z.boolean().default(false),
  /** 16 byte hex nonce chosen by the sender. The server picks one when it is absent and returns it to the pledger. */
  nonce: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  /**
   * The commitment the sender computed locally with `pledgeCommit(orders, nonce)`. When present the
   * server refuses the pledge (`bad_pledge`) unless its own commitment is identical, so a client can
   * prove to itself that the server sealed exactly what it was sent.
   */
  commitment: z.string().regex(/^[0-9a-f]{64}$/).optional(),
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
  /**
   * The nonce that opens the commitment. The pledger sees it at once; everybody else in the
   * audience sees it with the receipt, and can then check `pledgeOpens(commitment, orders, nonce)`.
   */
  nonce: z.string().nullable(),
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
  /** Consecutive missed movement phases. */
  missed: z.number().int().min(0),
  /** The built-in bot is covering this civil-disorder seat until its player returns. */
  autopilot: z.boolean().optional(),
  /** Who is playing an AI seat or covering a seat on autopilot right now; null for a seat a person plays. */
  brain: AiBrain.nullable(),
  /** A connection is bound to the seat. Always true for a seat played by AI. */
  present: z.boolean(),
  /** Orders are on file for the current phase. Never the orders themselves. */
  submitted: z.boolean(),
  /** The seat has something to order in the current phase. */
  canAct: z.boolean(),
  /** The seat of the player who created the game and may start it. */
  host: z.boolean(),
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

/** The phase a message was sent in, or `LOBBY` for table talk before the game starts. */
export const PressPhase = z.union([PhaseName, z.literal("LOBBY")]);
export type PressPhase = z.infer<typeof PressPhase>;

export const PressView = z.object({
  id: z.string(),
  phase: PressPhase,
  from: PowerName,
  to: Recipient,
  body: z.string(),
  sentAt: z.number().int(),
  pledge: PledgeView.nullable(),
});
export type PressView = z.infer<typeof PressView>;

// ---------- client -> server ----------

export const ClientMessage = z.discriminatedUnion("t", [
  /** First frame of a player's socket: binds it to a seat. Seat tokens never travel in a URL. */
  z.object({ t: z.literal("hello"), id: z.string().optional(), p: z.object({ token: z.string().max(128) }) }),
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
  z.object({ t: z.literal("extend"), id: z.string().optional(), p: z.object({ phase: PhaseName }) }),
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
    p: z.object({
      kind: z.literal("draw"),
      value: z.boolean(),
      /** Non-DIAS games only: the survivors who would share the draw. Absent means every survivor. */
      include: z.array(PowerName).min(1).max(7).optional(),
    }),
  }),
  /** Mark a thread read up to a message's `sentAt`. `with` is the other power, or `ALL` for the public thread. */
  z.object({
    t: z.literal("press.read"),
    id: z.string().optional(),
    p: z.object({ with: Recipient, upTo: z.number().int().min(0) }),
  }),
  z.object({
    t: z.literal("sync"),
    id: z.string().optional(),
    p: z.object({ since: z.number().int().min(0) }),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------- server -> client ----------

export const GameStatus = z.enum(["lobby", "active", "paused", "finished", "abandoned"]);
export type GameStatus = z.infer<typeof GameStatus>;

/** Draw votes of the current phase. They are cleared when the phase resolves. */
export const VotesView = z.object({
  phase: PhaseName,
  /**
   * The ballots the viewer may see. With `publicVotes` that is every vote cast this phase; without
   * it, only the viewer's own. `include` is the proposed set of sharers (non-DIAS), null for all survivors.
   */
  draw: z.array(z.object({ power: PowerName, value: z.boolean(), include: z.array(PowerName).nullable() })),
  /** The seats whose agreement a draw needs: surviving, present human players. */
  required: z.array(PowerName),
  /** True when the game hides who voted (`publicVotes: false`). */
  hidden: z.boolean(),
  /** Required voters who have voted, and how many of those voted yes. Always visible. */
  cast: z.number().int().min(0),
  yes: z.number().int().min(0),
});
export type VotesView = z.infer<typeof VotesView>;

export const GameResult = z.enum(["solo", "draw", "abandoned"]);
export type GameResult = z.infer<typeof GameResult>;

/** One resolved phase, as the history strip shows it: supply centres per power once it resolved. */
export const PhaseSummary = z.object({
  phase: PhaseName,
  adjudicatedAt: z.number().int(),
  centers: z.record(z.string(), z.number().int()),
});
export type PhaseSummary = z.infer<typeof PhaseSummary>;

/** What the server made of one submitted order, in the order it was sent. */
export const OrderVerdict = z.object({
  /** The text as the client sent it. */
  text: z.string(),
  /** Canonical MILA text when the order parsed; null otherwise. */
  order: z.string().nullable(),
  ok: z.boolean(),
  /** `ok`, `syntax`, `foreign_power`, `no_such_unit`, `illegal`, `superseded` or `over_allowance`. */
  code: z.string(),
  /** Why, in words a player can act on. Empty when `ok`. */
  reason: z.string(),
});
export type OrderVerdict = z.infer<typeof OrderVerdict>;

/**
 * One server frame. `seq` is present on every broadcast frame (anything `sync` can replay) and is
 * that frame's own number: a client keeps the highest it has applied and resumes with
 * `sync { since }`. Replies to a single socket (`welcome`, `orders.ack`, `synced`, `error`, ...) and
 * presence-only `seats` frames carry no `seq`.
 */
function frame<T extends string, P extends z.ZodType>(t: T, p: P) {
  return z.object({ t: z.literal(t), id: z.string().optional(), seq: z.number().int().min(1).optional(), p });
}

export const ServerMessage = z.discriminatedUnion("t", [
  frame(
    "welcome",
    z.object({
      /** `PROTOCOL_VERSION` of the server. */
      protocol: z.number().int(),
      gameId: z.string(),
      settings: GameSettings,
      status: GameStatus,
      pauseReason: z.string().nullable().optional(),
      /** While paused: when the pause ends by itself, and how much of the phase clock is left. */
      pausedUntil: z.number().int().nullable().optional(),
      pausedRemainingMs: z.number().int().nullable().optional(),
      /** The viewer's seat; null for a spectator. */
      power: PowerName.nullable(),
      /** The seat that created the game and may start it. */
      host: PowerName,
      phase: PhaseName,
      state: StateView,
      seats: z.array(SeatView),
      deadlineAt: z.number().int().nullable(),
      /** The server's clock when the frame was built, so a client can correct its own for countdowns. */
      serverTime: z.number().int(),
      /** The number of the last broadcast frame this snapshot already contains: the `sync` cursor. */
      seq: z.number().int(),
      /** The viewer's own orders on file for the current phase. */
      orders: z.array(OrderText),
      /** The viewer's own sealed default orders. */
      defaults: z.array(OrderText),
      /** The most recent press the viewer may read, oldest first. */
      press: z.array(PressView),
      /** True when older press exists than `press` holds; page it with `GET /api/games/:id/press`. */
      pressMore: z.boolean(),
      /** Unread messages per thread (`ALL` or the other power), from the viewer's read markers. */
      unread: z.record(z.string(), z.number().int()),
      votes: VotesView,
      /** Every resolved phase, oldest first. */
      history: z.array(PhaseSummary),
      finished: z
        .object({ result: GameResult, winners: z.array(PowerName), scores: z.record(z.string(), z.number()), reason: z.string().nullable() })
        .nullable(),
    }),
  ),
  frame(
    "state",
    z.object({
      phase: PhaseName,
      state: StateView,
      deadlineAt: z.number().int().nullable(),
      serverTime: z.number().int(),
      /** This frame's own number (the same as the envelope's `seq`). */
      seq: z.number().int(),
      status: GameStatus,
    }),
  ),
  frame(
    "results",
    z.object({
      phase: PhaseName,
      results: z.array(OrderResultView),
      dislodged: z.array(z.object({ unit: z.string(), attacker_from: z.string(), retreat_options: z.array(z.string()) })),
      standoffs: z.array(z.string()),
      civil_disorder: z.array(z.string()),
      /** Supply centres per power once the phase resolved (the entry appended to `welcome.history`). */
      summary: PhaseSummary,
      /** This frame's own number (the same as the envelope's `seq`). */
      seq: z.number().int(),
    }),
  ),
  frame(
    "orders.ack",
    z.object({
      phase: PhaseName,
      /** The orders now on file, in canonical text. */
      accepted: z.array(OrderText),
      rejected: z.array(z.object({ text: z.string(), reason: z.string() })),
      /** One verdict per order sent, in the order sent. */
      verdicts: z.array(OrderVerdict),
    }),
  ),
  /**
   * The sealed default orders now on file. They are checked for syntax and ownership only: the
   * board they will be used on is not known yet.
   */
  frame(
    "orders.default.ack",
    z.object({ accepted: z.array(OrderText), rejected: z.array(z.object({ text: z.string(), reason: z.string() })) }),
  ),
  frame("press", PressView),
  /** The viewer's unread counts after a `press.read`. Sent to every socket of the seat. */
  frame("press.unread", z.object({ unread: z.record(z.string(), z.number().int()) })),
  frame(
    "pledge.receipt",
    z.object({
      pledgeId: z.string(),
      receipt: Receipt,
      revealed: z.array(OrderText).nullable(),
      /** Opens the commitment: `pledgeOpens(commitment, revealed, nonce)`. */
      nonce: z.string(),
    }),
  ),
  frame("seats", z.object({ seats: z.array(SeatView) })),
  frame(
    "deadline",
    z.object({
      phase: PhaseName,
      deadlineAt: z.number().int().nullable(),
      serverTime: z.number().int(),
      /** True when this deadline is the one-off grace period. */
      grace: z.boolean().optional(),
    }),
  ),
  frame("extend.ack", z.object({ phase: PhaseName, requests: z.number().int().min(1), extended: z.boolean() })),
  /** Sent to everyone on each extension request, so a second seat can see one is pending. */
  frame(
    "extend",
    z.object({
      phase: PhaseName,
      requestedBy: z.array(PowerName),
      needed: z.number().int().min(1),
      granted: z.boolean(),
      deadlineAt: z.number().int().nullable(),
    }),
  ),
  frame("votes", VotesView),
  frame(
    "finished",
    z.object({
      result: GameResult,
      winners: z.array(PowerName),
      scores: z.record(z.string(), z.number()),
      reason: z.string().nullable().optional(),
    }),
  ),
  frame(
    "status",
    z.object({
      status: GameStatus,
      reason: z.string().nullable(),
      /** While paused: when the pause ends by itself. */
      until: z.number().int().nullable().optional(),
    }),
  ),
  /**
   * Ends the reply to a `sync`: the cursor to send next, and whether another page is waiting.
   * `gap` is true when frames after `since` are no longer stored; the client then asks for a fresh
   * `welcome` (send `hello` again) instead of trusting the replay.
   */
  frame("synced", z.object({ seq: z.number().int().min(0), more: z.boolean(), gap: z.boolean() })),
  frame("error", z.object({ code: z.string(), message: z.string() })),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---------- HTTP ----------

export const CreateGameRequest = z.object({
  settings: GameSettingsInput.default({}),
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
  /** Substitute invite issued by a seated player for one vacated seat of a running game. */
  invite: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});
export type JoinGameRequest = z.infer<typeof JoinGameRequest>;

export const JoinGameResponse = CreateGameResponse;
export type JoinGameResponse = z.infer<typeof JoinGameResponse>;

/** `POST /api/games/:id/substitute`: a seated player opens one vacated seat to an invited substitute. */
export const SubstituteInviteRequest = z.object({ power: PowerName });
export type SubstituteInviteRequest = z.infer<typeof SubstituteInviteRequest>;

export const SubstituteInviteResponse = z.object({ gameId: z.string(), power: PowerName, invite: z.string() });
export type SubstituteInviteResponse = z.infer<typeof SubstituteInviteResponse>;

/** `GET /api/games/:id`: what anybody may know about a game. */
export const GameSummary = z.object({
  id: z.string(),
  settings: GameSettings,
  status: GameStatus,
  phase: PhaseName,
  host: PowerName,
  deadlineAt: z.number().int().nullable(),
  serverTime: z.number().int(),
  createdAt: z.number().int(),
  seats: z.array(SeatView),
  finished: z
    .object({ result: GameResult, winners: z.array(PowerName), scores: z.record(z.string(), z.number()), reason: z.string().nullable() })
    .nullable(),
  pauseReason: z.string().nullable(),
  pausedUntil: z.number().int().nullable(),
  pausedRemainingMs: z.number().int().nullable(),
  history: z.array(PhaseSummary),
  /** Who plays the AI seats and what it has cost so far. */
  ai: z.object({
    brain: AiBrain,
    model: z.string().nullable(),
    claudeTurns: z.number(),
    claudeCalls: z.number(),
    spentUsd: z.number(),
    capUsd: z.number(),
    tokens: z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), cacheWriteTokens: z.number() }),
    stopped: z.string().nullable(),
  }),
});
export type GameSummary = z.infer<typeof GameSummary>;

/** One open or running public game, as `GET /api/games?status=open|active` lists it. */
export const GameListing = z.object({
  gameId: z.string(),
  status: z.enum(["lobby", "active", "paused"]),
  settings: GameSettings,
  cluster: z.string(),
  hostName: z.string().nullable(),
  /** Seats a person holds, and seats still unclaimed. */
  humans: z.number().int().min(0),
  openSeats: z.number().int().min(0),
  phase: PhaseName,
  deadlineAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type GameListing = z.infer<typeof GameListing>;

export const LedgerTotals = z.record(z.string(), z.object({ kept: z.number().int(), broken: z.number().int(), void: z.number().int() }));
export type LedgerTotals = z.infer<typeof LedgerTotals>;

/** One resolved pledge with everything needed to check it: `pledgeOpens(commitment, orders, nonce)`. */
export const LedgerEntry = z.object({
  id: z.string(),
  pledger: PowerName,
  audience: Recipient,
  phase: PhaseName,
  sealed: z.boolean(),
  commitment: z.string(),
  nonce: z.string(),
  orders: z.array(OrderText),
  receipt: Receipt,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/**
 * `GET /api/games/:id/ledger`. `ledger` counts every resolved pledge. `entries` lists the ones the
 * caller may read: pledges made to `ALL`, with a seat token also the private ones that seat made or
 * received, and every pledge once the game is over.
 */
export const LedgerResponse = z.object({ gameId: z.string(), ledger: LedgerTotals, entries: z.array(LedgerEntry) });
export type LedgerResponse = z.infer<typeof LedgerResponse>;

/** `GET /api/games/:id/press`: one page of press, oldest first, and whether older messages remain. */
export const PressPage = z.object({ gameId: z.string(), press: z.array(PressView), more: z.boolean() });
export type PressPage = z.infer<typeof PressPage>;

/**
 * `GET /api/games/:id/replay` is a MILA saved game with one extra key, `cabal`, that MILA tools
 * ignore: the resolved pledges the caller may read (same rule as the ledger) and the phase summaries.
 */
export const ReplayExtension = z.object({
  protocol: z.number().int(),
  status: GameStatus,
  finished: GameSummary.shape.finished,
  pledges: z.array(LedgerEntry),
  history: z.array(PhaseSummary),
});
export type ReplayExtension = z.infer<typeof ReplayExtension>;

export const HealthResponse = z.object({
  ok: z.boolean(),
  protocol: z.number().int(),
  /** Semantic version of the Rust engine compiled into this build. */
  engine: z.string(),
  /** Identifies the deployed build: the `BUILD_ID` variable, else the Worker version id, else `dev`. */
  build: z.string(),
  registry: z.object({ reachable: z.boolean(), schema: z.number().int().nullable() }),
  time: z.number().int(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** One row of the global games index kept by the `Registry` Durable Object. */
export const GameRecord = z.object({
  gameId: z.string(),
  result: GameResult,
  reason: z.string().nullable(),
  winners: z.array(PowerName),
  scores: z.record(z.string(), z.number()),
  settings: GameSettings,
  cluster: z.string(),
  phaseCount: z.number().int().min(0),
  createdAt: z.number().int(),
  finishedAt: z.number().int(),
  /** Pledge receipts per power for this game. */
  ledger: z.record(z.string(), z.object({ kept: z.number().int(), broken: z.number().int(), void: z.number().int() })),
  seats: z.array(
    z.object({
      power: PowerName,
      kind: SeatKind,
      name: z.string().nullable(),
      centers: z.number().int().min(0),
      eliminated: z.boolean(),
    }),
  ),
});
export type GameRecord = z.infer<typeof GameRecord>;

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

/** A draw's shares under the game's scoring rule. `centers` holds only the powers that share it. */
export function drawScores(scoring: Scoring, centers: Record<string, number>): Record<string, number> {
  return scoring === "dss" ? drawSize(centers) : sumOfSquares(centers);
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
