/** Handles and account refusals, said for the person at the keyboard. */
import { failureCode, failureText } from "../net/failure.js";

/** Turn a handle problem into a sentence for the person typing it. */
export function handleProblem(text: string): string | null {
  const t = text.trim();
  // The protocol's own rule (Handle in @cabal/protocol), written out so this file stays light.
  if (/^[A-Za-z][A-Za-z0-9_-]{2,19}$/.test(t)) return null;
  if (t.length === 0) return "Write a handle, or let the table pick one for you.";
  if (t.length < 3) return "A handle needs at least 3 characters.";
  if (t.length > 20) return "A handle can be at most 20 characters.";
  if (!/^[A-Za-z]/.test(t)) return "A handle starts with a letter.";
  return "Use letters, digits, _ and - only.";
}

/**
 * A handle folded as the server compares them for a confirmation: case and `_` for `-` do not
 * matter. (The server also folds look-alikes; typing the handle as shown always matches.)
 */
export function handleKey(text: string): string {
  return text.trim().toLowerCase().replace(/_/g, "-");
}

/** A refusal from the server, said for this dialog. */
export function accountFailure(error: unknown): string {
  switch (failureCode(error)) {
    case "handle_taken":
      return "Someone already has that handle. Try another.";
    case "handle_reserved":
      return "That handle is reserved. Try another.";
    case "handle_abusive":
      return "That handle is not allowed. Try another.";
    case "handle_shape":
      return "Use 3 to 20 letters, digits, _ or -, starting with a letter.";
    case "bad_recovery_code":
      return "That recovery code is not valid. Check it against the file you saved; a newer code replaces older ones.";
    case "rename_cooldown":
      return "A handle can be changed once every 14 days.";
    case "handle_mismatch":
      return "That is not the account's handle. Type it as it is shown.";
    default:
      return failureText(error);
  }
}
