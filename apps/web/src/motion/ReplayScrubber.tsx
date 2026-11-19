/**
 * The replay scrubber: the whole game as a ruled track, a tick per phase, a glyph over each
 * phase where something happened (a unit dislodged, centres changing hands, builds, a power
 * eliminated), year marks under it, and a square seal to drag. A native range input carries
 * the value, so keyboard (arrows, Home, End, Page keys) and screen readers work as for any
 * slider; the marks are drawn behind it to the same geometry.
 *
 * Shared: the sandbox's phase history uses it, and a replay page (/replay/:code) can too.
 * Glyphs differ in shape, not only colour.
 */
import type { CSSProperties } from "react";
import type { Headline, PhaseMark } from "./timeline.js";

export interface ReplayScrubberProps {
  /** One mark per resolved phase (motion/timeline.ts), oldest first. */
  marks: readonly PhaseMark[];
  /** The position shown: an index into `marks`, or `marks.length` for the phase in play now. */
  index: number;
  /** Called with the position the player moved to. */
  onSeek: (index: number) => void;
  /** How the position after the last mark is read out (`Spring 1903 movement, now`). */
  liveLabel: string;
  /** How a phase is read out; defaults to `<season> <year> results`. */
  phaseLabel?: (mark: PhaseMark) => string;
  /** Accessible name of the slider. */
  label?: string;
}

/** Thumb width in CSS pixels; keep in step with `.scrubber::-webkit-slider-thumb`. */
const THUMB = 14;

const GLYPH: Record<Exclude<Headline, null>, { title: string; d: string }> = {
  ended: { title: "Game over", d: "M1 9V1h6l-1.5 2L7 5H2.5" },
  eliminated: { title: "A power eliminated", d: "M1 1l6 6M7 1L1 7M4 0.5v7" },
  dislodged: { title: "Units dislodged", d: "M1 1l6 6M7 1L1 7" },
  captures: { title: "Centres changed hands", d: "M4 0.5L7.5 4 4 7.5 0.5 4z" },
  builds: { title: "Builds", d: "M1 1h6v6H1z" },
  disbands: { title: "Disbands", d: "M1 4h6" },
  standoffs: { title: "Standoffs", d: "M1 7L7 1" },
};

export function ReplayScrubber({ marks, index, onSeek, liveLabel, phaseLabel, label = "Scrub through the game" }: ReplayScrubberProps) {
  const max = Math.max(1, marks.length);
  const at = (i: number) => `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${i / max})`;
  const name = (i: number) => {
    const m = marks[i];
    if (!m) return liveLabel;
    const base = phaseLabel ? phaseLabel(m) : `${m.season} ${m.year} results`;
    return m.summary ? `${base}: ${m.summary}` : base;
  };
  let lastYear = "";
  return (
    <div className="timeline" style={{ "--at": `${(index / max) * 100}%` } as CSSProperties}>
      <div className="timeline-marks" aria-hidden="true">
        {marks.map((m, i) => {
          const g = m.headline ? GLYPH[m.headline] : null;
          const year = m.year !== lastYear && m.season === "Spring" ? m.year : null;
          if (year) lastYear = m.year;
          return (
            <span key={`${m.phase}-${i}`} className={`timeline-phase kind-${m.kind}${i === index ? " here" : ""}`} style={{ left: at(i) }}>
              {g ? (
                <svg className={`glyph ${m.headline}`} viewBox="0 0 8 10" width="8" height="10">
                  <title>{g.title}</title>
                  <path d={g.d} />
                </svg>
              ) : null}
              <span className="tick" />
              {year ? <span className="year">{year.slice(2)}</span> : null}
            </span>
          );
        })}
        <span className={`timeline-phase now${index >= marks.length ? " here" : ""}`} style={{ left: at(marks.length) }}>
          <span className="tick" />
        </span>
      </div>
      <input
        type="range"
        className="scrubber"
        min={0}
        max={marks.length}
        step={1}
        value={Math.min(index, marks.length)}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={name(index)}
      />
    </div>
  );
}
