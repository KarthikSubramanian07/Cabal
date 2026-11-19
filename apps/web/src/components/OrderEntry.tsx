import { type CSSProperties, type KeyboardEvent, forwardRef, useId, useMemo, useState } from "react";
import { titleCase } from "../game/notation.js";
import { type Suggestion, splitTyped, suggest } from "../game/typed.js";
import { POWER_COLOR } from "../map/Board.jsx";

export interface WriteResult {
  written: string[];
  refused: { input: string; reason: string }[];
}

/**
 * Orders typed in MILA, for players who would rather write than click: a combobox whose
 * suggestions are the engine's legal orders. Several orders can go in at once, separated by
 * semicolons. Every order is judged by the engine before it is written.
 */
export const OrderEntry = forwardRef<
  HTMLInputElement,
  {
    legal: readonly Suggestion[];
    active: string;
    onWrite: (inputs: string[]) => WriteResult;
  }
>(function OrderEntry({ legal, active, onWrite }, ref) {
  const id = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(-1);
  const [note, setNote] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);

  // Suggest for the order being typed: the last one when several are separated by semicolons.
  const current = text.split(";").at(-1) ?? "";
  const options = useMemo(() => suggest(current, legal, active), [current, legal, active]);
  const shown = open && options.length > 0;

  const write = (inputs: string[]) => {
    if (inputs.length === 0) return;
    const { written, refused } = onWrite(inputs);
    if (refused.length === 0) {
      setNote({ tone: "ok", text: `Written: ${written.join("; ")}.` });
      setText("");
    } else {
      const first = refused[0]!;
      const more = refused.length > 1 ? ` (and ${refused.length - 1} more)` : "";
      const done = written.length ? `Written: ${written.join("; ")}. ` : "";
      setNote({ tone: "fail", text: `${done}${first.input}: ${first.reason}${more}` });
      // Keep what was refused in the field, so it can be corrected.
      setText(refused.map((r) => r.input).join("; "));
    }
    setOpen(false);
    setAt(-1);
  };

  const accept = (s: Suggestion) => {
    const earlier = text.split(";").slice(0, -1);
    write([...earlier.flatMap(splitTyped), s.text]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!options.length) return;
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      // Positions cycle through every option and back to the text as typed (-1).
      const slots = options.length + 1;
      setAt((i) => ((i + 1 + step + slots) % slots) - 1);
    } else if (e.key === "Escape") {
      if (shown) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setAt(-1);
      }
    } else if (e.key === "Enter" && shown && at >= 0 && options[at]) {
      e.preventDefault();
      accept(options[at]!);
    }
  };

  const listId = `${id}-list`;
  return (
    <form
      className="order-entry"
      onSubmit={(e) => {
        e.preventDefault();
        write(splitTyped(text));
      }}
    >
      <label className="order-entry-label" htmlFor={`${id}-input`}>
        Write an order
      </label>
      <div className="order-entry-field">
        <input
          ref={ref}
          id={`${id}-input`}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={listId}
          aria-activedescendant={shown && at >= 0 ? `${id}-opt-${at}` : undefined}
          aria-describedby={`${id}-note`}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="A PAR - BUR"
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setOpen(true);
            setAt(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="btn small">
          Write
        </button>
        {shown ? (
          <ul className="order-entry-list" id={listId} role="listbox" aria-label="Legal orders">
            {options.map((s, i) => (
              <li
                key={`${s.power}-${s.text}`}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === at}
                // Keep focus in the field: the click must not blur it first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => accept(s)}
                style={{ "--power": POWER_COLOR[s.power] } as CSSProperties}
              >
                <code>{s.text}</code>
                <span className="order-entry-power">
                  <span className="swatch" aria-hidden />
                  {titleCase(s.power)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <ul id={listId} role="listbox" aria-label="Legal orders" hidden />
        )}
      </div>
      <p className={`order-entry-note${note?.tone === "fail" ? " alert" : ""}`} id={`${id}-note`} role="status" aria-live="polite">
        {note?.text ?? "MILA, as on a dispatch: A PAR - BUR, F BRE S A PAR - PIC. Separate several with ;"}
      </p>
    </form>
  );
});
