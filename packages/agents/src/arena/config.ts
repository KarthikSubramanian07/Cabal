/**
 * What `pnpm arena` was asked to play, and the seats that play it.
 *
 * Free by default: every seat is the Rust bot. Claude seats are opt-in, seat by seat, and only
 * with an API key in the environment and a hard budget for the whole run. Each Claude seat is
 * then capped twice, by its share of the budget and by the budget itself, and plays the bot's
 * orders once either is reached, so a run can never cost more than it was given.
 */
import { parseArgs } from "node:util";
import { type BotLevel, POWERS } from "@cabal/engine";
import { BotBrain } from "../bot-brain.js";
import { CappedBrain, FailoverBrain, SpendCap } from "../budget.js";
import { type Brain, ClaudeBrain, DEFAULT_MODEL, PERSONAS, Player } from "../player.js";
import type { PressMode } from "./local.js";

export interface ArenaConfig {
  games: number;
  untilYear: number;
  seed: string;
  /** Bot levels, given to the seven powers in turn. */
  levels: BotLevel[];
  treachery: number;
  press: PressMode;
  negotiate: boolean;
  out: string;
  /** Play through a running server at this origin instead of in process. */
  server: string | null;
  /** Start `wrangler dev` for the run and play through it. */
  wrangler: boolean;
  /** Powers played by Claude. Empty unless asked for. */
  claude: string[];
  model: string;
  /** The hard cap on what the whole run may spend, in micro-dollars. Zero without Claude seats. */
  budgetMicros: number;
  /** Exit non-zero when a game fails the gates. */
  check: boolean;
  /** Keep each decision's prompt in the decisions log. */
  prompts: boolean;
}

export const USAGE = `pnpm arena [options]

Seven AI seats play a game of Cabal to the end of a year and the run is written up: the MILA saved
games, a decisions log, and a summary in JSON and Markdown. Every seat is the free Rust bot unless
Claude seats are asked for.

  --games N          games to play (default 1)
  --until YEAR       play to the end of this year (default 1910)
  --seed TEXT        base seed; game n is TEXT plus n (default ARENA)
  --levels LIST      bot levels given to the powers in turn (default hard,standard,easy)
  --treachery X      chance a bot breaks a pledge it made, 0 to 1 (default 0.2)
  --press MODE       full, public or gunboat (default full)
  --no-negotiate     one step per phase, no opening round of press
  --out DIR          where to write the run (default arena-out)
  --server URL       play through a running cabal-server instead of in process
  --wrangler         start wrangler dev for the run and play through it
  --claude LIST      powers played by Claude (AUSTRIA,FRANCE or all); needs ANTHROPIC_API_KEY
                     and --budget, and spends real money
  --model ID         Claude model for those seats (default ${DEFAULT_MODEL})
  --budget USD       hard cap on what the whole run may spend; required with --claude
  --check            exit 1 when a game fails the gates
  --no-prompts       leave prompts out of the decisions log
  --help             this text
`;

export class ArenaUsageError extends Error {
  override readonly name = "ArenaUsageError";
}

const LEVELS: BotLevel[] = ["easy", "standard", "hard"];

export function parseArenaArgs(argv: string[], env: Record<string, string | undefined>): ArenaConfig | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        games: { type: "string", default: "1" },
        until: { type: "string", default: "1910" },
        seed: { type: "string", default: "ARENA" },
        levels: { type: "string", default: "hard,standard,easy" },
        treachery: { type: "string", default: "0.2" },
        press: { type: "string", default: "full" },
        "no-negotiate": { type: "boolean", default: false },
        out: { type: "string", default: "arena-out" },
        server: { type: "string" },
        wrangler: { type: "boolean", default: false },
        claude: { type: "string" },
        model: { type: "string", default: DEFAULT_MODEL },
        budget: { type: "string" },
        check: { type: "boolean", default: false },
        "no-prompts": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    throw new ArenaUsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.help) return "help";
  const int = (name: string, text: string, min: number, max: number): number => {
    const n = Number(text);
    if (!Number.isInteger(n) || n < min || n > max) throw new ArenaUsageError(`--${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const levels = parsed.levels.split(",").map((l) => l.trim());
  for (const l of levels) if (!LEVELS.includes(l as BotLevel)) throw new ArenaUsageError(`unknown bot level ${l}; use ${LEVELS.join(", ")}`);
  const treachery = Number(parsed.treachery);
  if (!(treachery >= 0 && treachery <= 1)) throw new ArenaUsageError("--treachery must be from 0 to 1");
  if (!["full", "public", "gunboat"].includes(parsed.press)) throw new ArenaUsageError("--press must be full, public or gunboat");
  if (parsed.server && parsed.wrangler) throw new ArenaUsageError("--server and --wrangler are two ways to name a server; pick one");
  if (!/^[A-Z0-9]{1,12}$/.test(parsed.seed)) throw new ArenaUsageError("--seed must be 1 to 12 upper-case letters or digits");

  let claude: string[] = [];
  let budgetMicros = 0;
  if (parsed.claude !== undefined) {
    claude = parsed.claude.trim().toLowerCase() === "all" ? [...POWERS] : parsed.claude.split(",").map((p) => p.trim().toUpperCase());
    for (const p of claude) if (!(POWERS as readonly string[]).includes(p)) throw new ArenaUsageError(`unknown power ${p}`);
    if (!env.ANTHROPIC_API_KEY) throw new ArenaUsageError("--claude needs ANTHROPIC_API_KEY in the environment");
    if (parsed.budget === undefined) throw new ArenaUsageError("--claude needs --budget: the most the whole run may spend, in dollars");
    const usd = Number(parsed.budget);
    if (!(usd > 0 && usd <= 100)) throw new ArenaUsageError("--budget must be more than 0 and at most 100 dollars");
    budgetMicros = Math.floor(usd * 1_000_000);
  } else if (parsed.budget !== undefined) {
    throw new ArenaUsageError("--budget only applies to Claude seats; bot seats are free");
  }

  return {
    games: int("games", parsed.games, 1, 1000),
    untilYear: int("until", parsed.until, 1901, 1950),
    seed: parsed.seed,
    levels: levels as BotLevel[],
    treachery,
    press: parsed.press as PressMode,
    negotiate: !parsed["no-negotiate"],
    out: parsed.out,
    server: parsed.server ?? null,
    wrangler: parsed.wrangler,
    claude,
    model: parsed.model,
    budgetMicros,
    check: parsed.check,
    prompts: !parsed["no-prompts"],
  };
}

/** One spend cap for the whole run; created once and shared by every game's Claude seats. */
export function runCap(config: ArenaConfig): SpendCap | null {
  return config.claude.length === 0 ? null : new SpendCap(config.budgetMicros, "run budget");
}

/**
 * The seven players of game `gameId`. A Claude seat's cap is its share of the run budget over
 * the run's games, and it is under the run cap as well. `claudeFor` builds the model brain (tests
 * pass a fake; nothing here calls the API by itself).
 */
export function arenaPlayers(
  config: ArenaConfig,
  gameId: string,
  run: SpendCap | null,
  claudeFor: (model: string) => Brain = (model) => new ClaudeBrain({ model }),
): Player[] {
  const seatShare = config.claude.length === 0 ? 0 : Math.floor(config.budgetMicros / (config.claude.length * config.games));
  return POWERS.map((power, i) => {
    const bot = new BotBrain({ seed: gameId, level: config.levels[i % config.levels.length]!, treachery: config.treachery });
    if (!config.claude.includes(power) || run === null) return new Player(power, PERSONAS[power]!, bot);
    const capped = new CappedBrain(claudeFor(config.model), config.model, [new SpendCap(seatShare, `${power} seat budget`), run]);
    return new Player(power, PERSONAS[power]!, new FailoverBrain(capped, bot));
  });
}
