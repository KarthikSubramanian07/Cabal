/**
 * Counting text the way a reader does. A quote's excerpt is cut by the room and previewed by the
 * client, and the two must agree on what "280 characters" means, whatever the text is made of.
 *
 * A character here is a grapheme cluster, what a reader sees as one character: a letter with its
 * combining accents, an emoji with its skin tone, a family joined by zero width joiners, a flag
 * made of two regional indicators. JavaScript's `length` counts UTF-16 units (an emoji is two or
 * more) and spreading a string counts code points (an accent is one more); neither is what a
 * reader counts, and cutting by either can split a character in two.
 */

/** How much of a quoted message travels with the reply that quotes it, ellipsis included. */
export const QUOTE_CHARS = 280;

type Segmenter = { segment(text: string): Iterable<{ segment: string }> };
const segmenter: Segmenter | null = (() => {
  const Ctor = (globalThis.Intl as { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => Segmenter } | undefined)?.Segmenter;
  return Ctor ? new Ctor(undefined, { granularity: "grapheme" }) : null;
})();

/** Without `Intl.Segmenter`: a code point and the combining marks after it, at least never splitting an accent from its letter. */
const FALLBACK = /\P{M}\p{M}*|\p{M}+/gu;

/** The characters of a text as a reader counts them. */
export function graphemes(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  return text.match(FALLBACK) ?? [];
}

/**
 * The start of a text, at most `limit` characters as a reader counts them: the whole text when it
 * fits, otherwise its first characters and an ellipsis (which counts as one). Never cuts a
 * character in two.
 */
export function excerpt(text: string, limit: number = QUOTE_CHARS): string {
  const chars = graphemes(text);
  if (chars.length <= limit) return text;
  return `${chars.slice(0, Math.max(0, limit - 1)).join("").trimEnd()}…`;
}
