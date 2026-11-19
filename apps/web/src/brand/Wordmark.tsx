/**
 * The CABAL wordmark: a heavy grotesque with the second A turned over in vermilion,
 * traced from the brand concept art (docs/brand) so it renders crisply at any size.
 * The paths live in wordmark.json so the static trust pages draw the same mark.
 */
import mark from "./wordmark.json";

export interface WordmarkProps {
  /** Height in CSS pixels. */
  height?: number;
  /** Colour of the upright letters. The turned A is always vermilion. */
  color?: string;
  title?: string;
}

const [, , VB_W, VB_H] = mark.viewBox.split(" ").map(Number) as [number, number, number, number];

export function Wordmark({ height = 24, color = "currentColor", title = "Cabal" }: WordmarkProps) {
  return (
    <svg
      viewBox={mark.viewBox}
      width={(height * VB_W) / VB_H}
      height={height}
      role="img"
      aria-label={title}
      className="wordmark"
    >
      <path fillRule="evenodd" fill={color} d={mark.letters} />
      <path fillRule="evenodd" fill="var(--vermilion, #d94f30)" d={mark.turnedA} />
    </svg>
  );
}
