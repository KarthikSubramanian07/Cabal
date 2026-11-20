/**
 * The small menu that opens over the board when one tap could mean several orders: which coast
 * a fleet sails to, an army or a fleet for a build. Shared by the sandbox and the live room, so
 * both behave the same for a finger and for a keyboard:
 *
 *  - focus moves into the menu when it opens, and the arrow keys, Home and End move through it
 *    (Escape is the page's, and cancels);
 *  - the click a touch sends after the tap that opened the menu under the finger is ignored, so
 *    the menu never chooses for the player.
 */
import { type Ref, useEffect, useRef } from "react";

export interface PickerState {
  x: number;
  y: number;
  title: string;
  power: string;
  key: string;
  options: string[];
  /** When and where it was opened, to ignore the click a touch sends after the tap that opened it. */
  openedAt: number;
  openedBy: { x: number; y: number } | null;
}

/** Where an order picker opens: under the pointer, or the middle of the board, kept on the map. */
export function placePicker(
  wrap: DOMRect | undefined,
  frame: DOMRect | undefined,
  options: number,
  client?: { x: number; y: number },
): { x: number; y: number } {
  const half = 100;
  const tall = 34 + options * 44;
  const x = client && wrap ? client.x - wrap.left : wrap ? wrap.width / 2 : 40;
  const y = client && wrap ? client.y - wrap.top : wrap ? wrap.height / 3 : 40;
  const maxY = frame && wrap ? frame.bottom - wrap.top - tall - 12 : y;
  return { x: wrap ? Math.min(Math.max(x, half), wrap.width - half) : x, y: Math.max(0, Math.min(y, maxY)) };
}

/** Whether a click is the one a touch sends after the tap that opened the picker under it. */
export function echoOfOpeningTap(picker: Pick<PickerState, "openedAt" | "openedBy">, click: { x: number; y: number; at: number }): boolean {
  const from = picker.openedBy;
  const sameSpot = from !== null && Math.hypot(click.x - from.x, click.y - from.y) < 16;
  return sameSpot && click.at - picker.openedAt < 700;
}

export function OrderPicker({ picker, onChoose, menuRef }: { picker: PickerState; onChoose: (order: string) => void; menuRef?: Ref<HTMLDivElement> }) {
  const own = useRef<HTMLDivElement>(null);
  // Into the menu as it opens, so a keyboard (or a screen reader) is where the choice is.
  useEffect(() => {
    own.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, [picker.key, picker.openedAt]);
  const setRef = (el: HTMLDivElement | null) => {
    own.current = el;
    if (typeof menuRef === "function") menuRef(el);
    else if (menuRef) (menuRef as { current: HTMLDivElement | null }).current = el;
  };
  return (
    <div
      className="picker"
      ref={setRef}
      style={{ left: picker.x, top: picker.y }}
      role="menu"
      aria-labelledby="picker-title"
      onKeyDown={(e) => {
        // Menu keys: arrows and Home/End move between options; Escape cancels (the page's handler).
        const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          e.key === "ArrowDown"
            ? (at + 1) % items.length
            : e.key === "ArrowUp"
              ? (at - 1 + items.length) % items.length
              : e.key === "Home"
                ? 0
                : e.key === "End"
                  ? items.length - 1
                  : -1;
        if (next < 0) return;
        e.preventDefault();
        e.stopPropagation();
        items[next]?.focus();
      }}
    >
      <div className="picker-title" id="picker-title" role="presentation">
        {picker.title}
      </div>
      {picker.options.map((o) => (
        <button
          key={o}
          type="button"
          role="menuitem"
          onClick={(e) => {
            if (echoOfOpeningTap(picker, { x: e.clientX, y: e.clientY, at: e.timeStamp })) return;
            onChoose(o);
          }}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
