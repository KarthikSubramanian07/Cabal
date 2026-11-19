/**
 * The front door at `/`. The hero is the war room at night: the Channel cut from the game's own
 * board, a dispatch from England to France sealed in wax, the phase resolving, and the BROKEN
 * stamp coming down on the promise. Then a year at the table, the Ledger, the rivals and the
 * engine, in Cabal's own words.
 *
 * The page is drawn into the HTML at build time (prerender.tsx), so its headline paints before any
 * script runs, and the browser hydrates it. It imports nothing heavy: the API client, the create
 * dialog and the quick game are fetched when someone presses a button.
 */
import { type CSSProperties, type RefObject, Suspense, lazy, useEffect, useRef, useState } from "react";
import { Link, navigate } from "../app/router.jsx";
import { failureText } from "../net/failure.js";
import { useIdentity } from "../profile/Identity.jsx";
import { EXAMPLE_RECEIPTS } from "./receipts.js";

const CreateGameDialog = lazy(() => import("../lobby/CreateGameDialog.jsx").then((m) => ({ default: m.CreateGameDialog })));

const POWERS = [
  ["AUSTRIA", "Austria"],
  ["ENGLAND", "England"],
  ["FRANCE", "France"],
  ["GERMANY", "Germany"],
  ["ITALY", "Italy"],
  ["RUSSIA", "Russia"],
  ["TURKEY", "Turkey"],
] as const;

/** The scalloped edge of a wax seal, 24 units across. */
const WAX = "M12 1l2.6 1.9 3.2-.3 1.3 3 3 1.3-.3 3.2L23.7 12l-1.9 2.6.3 3.2-3 1.3-1.3 3-3.2-.3L12 23.7l-2.6-1.9-3.2.3-1.3-3-3-1.3.3-3.2L.3 12l1.9-2.6-.3-3.2 3-1.3 1.3-3 3.2.3z";

function Seal({ letter, broken = false }: { letter: string; broken?: boolean }) {
  return (
    <svg className={`seal-wax${broken ? " cracks" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
      <path className="seal-fill" d={WAX} />
      <circle className="seal-ring" cx="12" cy="12" r="7.2" />
      <text x="12" y="15.6" textAnchor="middle">
        {letter}
      </text>
      {broken ? <path className="seal-crack" d="M13.5 1.6l-2 5 2.6 3.2-3.4 4.4 2 3.6-1.6 5.8" /> : null}
    </svg>
  );
}

/**
 * The page's one moment of motion plays where the reader can see it. The animations start with the
 * page; if the dispatch is below the fold (a phone), they are held at their start until it scrolls
 * into view. Without script, or with reduced motion, nothing is held.
 */
function useSeenFirst(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root || typeof IntersectionObserver === "undefined" || typeof root.getAnimations !== "function") return;
    const slip = root.querySelector(".dispatch-slip") ?? root;
    const box = slip.getBoundingClientRect();
    if (box.top < window.innerHeight * 0.75 && box.bottom > 0) return;
    const turncoat = document.querySelector<HTMLElement>(".table-seals .turncoat");
    const held = [...root.getAnimations({ subtree: true }), ...(turncoat?.getAnimations({ subtree: true }) ?? [])];
    if (held.length === 0) return;
    for (const a of held) {
      a.pause();
      a.currentTime = 0;
    }
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        seen.disconnect();
        for (const a of held) a.play();
      },
      { threshold: 0.6 },
    );
    seen.observe(slip);
    return () => seen.disconnect();
  }, [ref]);
}

/** The Channel with London's fleet sailing into it: the order that breaks the promise. */
function Theatre() {
  const ref = useRef<HTMLDivElement>(null);
  useSeenFirst(ref);
  return (
    <div className="theatre" ref={ref}>
      <div className="theatre-map">
        <img
          src="/art/channel.svg"
          width={760}
          height={720}
          alt="The English Channel on the game's map. When the phase resolves, England's fleet sails from London into the Channel."
          decoding="async"
          fetchPriority="low"
        />
        <svg className="theatre-orders" viewBox="150 395 380 360" aria-hidden="true">
          <path className="order-line" d="M295.6 567.1 Q 262 603 226.5 616.5" />
          <path className="order-head" d="M222 618.6l8.6-7.5-0.8 10.9z" />
          <g className="fleet london">
            <rect x="-9" y="-6" width="18" height="12" />
            <text y="3.6" textAnchor="middle">
              F
            </text>
          </g>
          <g className="fleet france" transform="translate(228.3 661)">
            <rect x="-9" y="-6" width="18" height="12" />
            <text y="3.6" textAnchor="middle">
              F
            </text>
          </g>
          <text className="sea-name" x="196" y="636">
            English Channel
          </text>
        </svg>
      </div>
      <div className="dispatch-slip">
        <p className="note-head">
          <span>England to France</span>
          <span>Spring 1901</span>
        </p>
        <p className="note-body">“Keep your fleets out of the Channel and I will keep mine out. The water between us stays empty. You have my word.”</p>
        <p className="note-seal">
          <Seal letter="E" broken />
          <span>
            Sealed with <code>F LON H</code>
          </span>
        </p>
        <p className="dispatch-receipt">
          Ordered <code>F LON - ENG</code>
        </p>
        <span className="broken-stamp">Broken</span>
      </div>
    </div>
  );
}

function PlayNow({ onCreate }: { onCreate: () => void }) {
  const { asPlayer } = useIdentity();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function play() {
    if (busy) return;
    setError(null);
    try {
      const code = await asPlayer("You are about to sit down against six bots. The table, the Ledger and your record will know you by this name.", async (me) => {
        setBusy(true);
        const { startQuickGame } = await import("../lobby/quickGame.js");
        return startQuickGame(me);
      });
      if (code) navigate(`/g/${code}`);
      else setBusy(false);
    } catch (err) {
      setError(failureText(err));
      setBusy(false);
    }
  }

  return (
    <div className="hero-actions">
      <button type="button" className="hero-play" onClick={play} disabled={busy}>
        <span className="hero-play-label">{busy ? "Dealing the powers" : "Play now"}</span>
        <span className="hero-play-note">You and six bots, in seconds</span>
      </button>
      <button type="button" className="hero-second" onClick={onCreate}>
        Set a table for friends
      </button>
      <Link className="hero-third" href="/sandbox">
        Try the sandbox
      </Link>
      {error ? (
        <p className="hero-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const YEAR = [
  {
    season: "Talk",
    body: "Write privately to any power, or to the whole table. Offer a border, ask for a support, promise the Channel stays empty. Anyone can say anything.",
  },
  {
    season: "Seal",
    body: "Attach a seal to a promise: the exact orders you will give, sealed on your device. The other players see only the wax until the phase resolves.",
  },
  {
    season: "Order",
    body: "Write orders on the map or type them. Nobody sees anyone's orders until every power has moved, so a promise is only as good as the order behind it.",
  },
  {
    season: "Reckon",
    body: "The engine resolves every order and gives each one a reason. Then each seal is opened and stamped Kept, Broken or Void, and the table's Ledger writes it down for good.",
  },
];

export default function LandingPage() {
  const [creating, setCreating] = useState(false);
  return (
    <main className="landing" id="main" tabIndex={-1}>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-grid">
          <div className="hero-copy">
            <h1 id="hero-title" className="hero-title">
              <span>Shake hands.</span> <span>Seal it.</span> <span>Break it.</span>
            </h1>
            <p className="hero-lede">
              Cabal is Diplomacy in your browser. Seven great powers, orders written in secret and resolved all at once, and promises you can seal in wax. When the phase resolves, every
              seal is opened and the Ledger keeps score of who kept their word.
            </p>
            <PlayNow onCreate={() => setCreating(true)} />
            <p className="hero-fine">No email and no download. Pick a handle and you are at the table.</p>
          </div>
          <Theatre />
        </div>
        <ul className="table-seals" aria-label="The seven great powers">
          {POWERS.map(([id, name]) => (
            <li key={id} style={{ "--power": `var(--p-${id.toLowerCase()})` } as CSSProperties} className={id === "ENGLAND" ? "turncoat" : undefined}>
              <Seal letter={name[0]!} broken={id === "ENGLAND"} />
              <span>{name}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="year-band" aria-labelledby="year-title">
        <div className="landing-inner">
          <h2 id="year-title" className="landing-h2">
            A phase at the table
          </h2>
          <ol className="year-steps">
            {YEAR.map((step) => (
              <li key={step.season}>
                <h3>{step.season}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="ledger-band" aria-labelledby="ledger-title">
        <div className="landing-inner ledger-grid">
          <div>
            <h2 id="ledger-title" className="landing-h2">
              The Ledger remembers
            </h2>
            <p>
              Every rated game a player finishes goes on their record: how many promises they kept and how many they broke, to the other people at the table. Before you trust a stranger
              with your flank, look them up.
            </p>
            <p>
              A game is rated when its table is public, it reaches a result after two full years, and at least three signed-in players sat at it. Friendly tables, Play now among
              them, keep their seals on the table&apos;s own Ledger and off the player&apos;s record, so nobody can farm a reputation against bots.
            </p>
            <p>
              Ratings rank who wins. The Ledger ranks who can be believed. A player can top one and sit at the foot of the other, and the best players learn which matters more at
              which table.
            </p>
            <Link className="landing-link" href="/ledger">
              Open the Ledger
            </Link>
          </div>
          <div className="ledger-slip" role="img" aria-label="A ledger page with three receipts: a promise kept, a promise broken and a promise void.">
            <p className="slip-head">Receipts, Fall 1902</p>
            {EXAMPLE_RECEIPTS.map((r) => (
              <p className="slip-row" key={r.who}>
                <span className="slip-who">{r.who}</span>
                <code>{r.order}</code>
                <span className={`slip-stamp ${r.stamp}`}>{r.stamp[0]!.toUpperCase() + r.stamp.slice(1)}</span>
              </p>
            ))}
            <p className="slip-note">An example page. Real receipts are on each player&apos;s record.</p>
          </div>
        </div>
      </section>

      <section className="rivals" aria-labelledby="rivals-title">
        <div className="landing-inner rivals-grid">
          <h2 id="rivals-title" className="landing-h2">
            Rivals that never miss a turn
          </h2>
          <div className="rivals-copy">
            <p>
              Diplomacy needs seven players, and seven people rarely turn up. At Cabal no seat waits. Any empty one is played by Cabal&apos;s own bot, written in Rust: it orders
              instantly, never sulks and never walks out. Play now seats you against six of them.
            </p>
            <p>
              A host can seat Claude instead. Claude reads the press, writes back and plays its own game, within a spending cap set for the table. If Claude cannot answer, the bot takes
              the seat for that phase, so the game never stalls.
            </p>
          </div>
        </div>
      </section>

      <section className="proof-band" aria-labelledby="proof-title">
        <div className="landing-inner proof-grid">
          <h2 id="proof-title" className="landing-h2">
            Rules you can check
          </h2>
          <div>
            <p>
              Cabal&apos;s adjudicator passes all 171 cases of the Diplomacy Adjudicator Test Cases. It is written in Rust and runs in your browser as WebAssembly, and every result comes
              with its reason: why a move bounced, which support was cut, how a convoy was disrupted. The engine, the server and this site are open source under the MIT licence.
            </p>
            <p className="proof-links">
              <Link className="landing-link" href="/sandbox">
                Order all seven powers in the sandbox
              </Link>
              <a className="landing-link" href="https://github.com/KarthikSubramanian07/Cabal">
                Read the source
              </a>
            </p>
          </div>
        </div>
      </section>

      <section className="last-call" aria-labelledby="last-title">
        <div className="landing-inner last-grid">
          <h2 id="last-title" className="landing-h2">
            The table is set.
          </h2>
          <div className="last-actions">
            <Link className="btn brass big" href="/games">
              Find a table
            </Link>
            <button type="button" className="btn big" onClick={() => setCreating(true)}>
              Set a table for friends
            </button>
          </div>
        </div>
      </section>

      {creating ? (
        <Suspense fallback={null}>
          <CreateGameDialog open onClose={() => setCreating(false)} />
        </Suspense>
      ) : null}
    </main>
  );
}
