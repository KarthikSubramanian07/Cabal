import { describe, expect, it } from "vitest";
import { handleKey, handleProblem, maskHandles, pickHandle } from "../src/handles.js";

describe("handles", () => {
  it("accepts ordinary names, whatever their case", () => {
    for (const ok of ["Talleyrand", "von_Bismarck", "Metternich-1815", "ann", "Scunthorpe", "Therapist", "Nazir", "Spicer", "Stafford", "Cockburn", "Niger_Delta"]) {
      expect(handleProblem(ok), ok).toBeNull();
    }
    expect(handleKey("  Talleyrand ")).toBe("talleyrand");
  });

  it("keys handles by how they read, so a look-alike cannot sit beside a handle", () => {
    expect(handleKey("Envoy_4821")).toBe(handleKey("Envoy-4821"));
    expect(handleKey("TaIleyrand")).toBe(handleKey("Talleyrand")); // a capital i
    expect(handleKey("Ta1leyrand")).toBe(handleKey("Talleyrand"));
    expect(handleKey("B0ris")).toBe(handleKey("Boris"));
    expect(handleKey("Kern")).toBe(handleKey("Kem"));
    expect(handleKey("Vvolf")).toBe(handleKey("Wolf"));
    expect(handleKey("Ca5tle")).toBe(handleKey("Castle"));
    expect(handleKey("Ann")).not.toBe(handleKey("Anne"));
    // A key is its own key, so stored keys never drift.
    for (const h of ["Envoy_4821", "TaIleyrand", "Kern", "VVVolf", "rrnn_Oo1i", "Metternich-1815"]) expect(handleKey(handleKey(h))).toBe(handleKey(h));
  });

  it("refuses the wrong shape", () => {
    for (const bad of ["ab", "1stPlace", "_under", "a".repeat(21), "has space", "émile", "semi;colon"]) expect(handleProblem(bad), bad).toBe("shape");
  });

  it("refuses names that pass for the house", () => {
    for (const bad of ["Admin", "admin_2", "SYSTEM", "Claude", "Automaton", "Cabal_Official", "m0derator", "Bot"]) expect(handleProblem(bad), bad).toBe("reserved");
  });

  it("refuses look-alikes and variants of the house's names", () => {
    const bad = ["CabaI-Official", "CabaI", "Cabai_Team", "OfficiaI", "Automaton2", "AutomatonPrime", "Claude_AI", "ClaudeAI", "claude-2", "Mod_Team", "Staff1", "Anthropic", "Anthr0pic_Labs", "Support-Desk", "Adm1n", "Sys7em"];
    for (const handle of bad) expect(handleProblem(handle), handle).toBe("reserved");
    for (const ok of ["Claudette", "Claudius", "Modena", "Modest_Mouse", "Stafford", "Supporter", "Robot_Wars", "Talbot"]) expect(handleProblem(ok), ok).toBeNull();
  });

  it("refuses the worst abuse, letter swaps included", () => {
    for (const bad of ["fuckface", "F_U_C_K_off", "Big_Cunt", "NaziGeneral", "sh1t", "Hitler1945", "f4gg0t"]) expect(handleProblem(bad), bad).toBe("abusive");
  });

  it("picks a valid, unreserved handle for a player who did not choose one", () => {
    for (let i = 0; i < 200; i++) expect(handleProblem(pickHandle())).toBeNull();
    expect(pickHandle(() => 0)).toBe("Envoy-1000");
  });

  it("masks handles where they can be told from other words, as codes are masked", () => {
    // In a record's address, with or without the API's prefix and whatever follows.
    expect(maskHandles("no profile at /u/Talleyrand")).toBe("no profile at /u/<handle>");
    expect(maskHandles("GET /api/players/von_Bismarck/ratings failed")).toBe("GET /api/players/<handle>/ratings failed");
    expect(maskHandles("open('/u/Metternich-1815')")).toBe("open('/u/<handle>')");
    // After the word handle, given with a colon, an equals sign or quotes.
    expect(maskHandles('no player with handle "Talleyrand"')).toBe('no player with handle "<handle>"');
    expect(maskHandles("rename failed: handle: Talleyrand")).toBe("rename failed: handle: <handle>");
    expect(maskHandles("handle=Talleyrand&x=1")).toBe("handle=<handle>&x=1");
    // A handle picked for a guest, in any case, wherever it stands.
    expect(maskHandles("Envoy-4821 left the table")).toBe("<handle> left the table");
    expect(maskHandles(`seat of ${pickHandle(() => 0.5).toUpperCase()}`)).toBe("seat of <handle>");
    // Masking twice changes nothing.
    expect(maskHandles(maskHandles("/u/Talleyrand and Envoy-4821"))).toBe("/u/<handle> and <handle>");
  });

  it("leaves ordinary messages alone", () => {
    for (const text of [
      "Cannot read properties of undefined (reading 'units')",
      "Unhandled rejection: handle the click first",
      "FRANCE cannot move: failed",
      "Failed to fetch dynamically imported module",
      "at deleteAccount (src/players.ts:236:9)",
      "Envoy is not defined",
    ]) {
      expect(maskHandles(text), text).toBe(text);
    }
  });
});
