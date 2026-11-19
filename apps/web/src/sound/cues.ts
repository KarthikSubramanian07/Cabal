/** The sounds of the table. Each is synthesised in code (voices.ts); there are no audio files. */
export type SoundName =
  /** A rubber stamp coming down on paper: a failed order, a unit knocked out, a build. */
  | "thud"
  /** A nib across paper: an order written. */
  | "quill"
  /** Boots on boards, a few paces: units on the move. */
  | "march"
  /** Wax giving way: the seals on the orders broken as a phase is read. */
  | "crack"
  /** A telegraph key: a dispatch in, a phase stepped to. */
  | "tick";

export const SOUND_NAMES: readonly SoundName[] = ["thud", "quill", "march", "crack", "tick"];

export interface Cue {
  /** Milliseconds from the start of whatever is playing. */
  at: number;
  sound: SoundName;
  /** Louder and lower above 1 (a unit knocked out hits harder than a cut support). */
  weight?: number;
}
