import { describe, expect, it } from "vitest";
import { handleKey, handleProblem, pickHandle } from "../src/handles.js";

describe("handles", () => {
  it("accepts ordinary names, whatever their case", () => {
    for (const ok of ["Talleyrand", "von_Bismarck", "Metternich-1815", "ann", "Scunthorpe", "Therapist", "Nazir", "Spicer", "Stafford", "Cockburn", "Niger_Delta"]) {
      expect(handleProblem(ok), ok).toBeNull();
    }
    expect(handleKey("  Talleyrand ")).toBe("talleyrand");
  });

  it("refuses the wrong shape", () => {
    for (const bad of ["ab", "1stPlace", "_under", "a".repeat(21), "has space", "émile", "semi;colon"]) expect(handleProblem(bad), bad).toBe("shape");
  });

  it("refuses names that pass for the house", () => {
    for (const bad of ["Admin", "admin_2", "SYSTEM", "Claude", "Automaton", "Cabal_Official", "m0derator", "Bot"]) expect(handleProblem(bad), bad).toBe("reserved");
  });

  it("refuses the worst abuse, letter swaps included", () => {
    for (const bad of ["fuckface", "F_U_C_K_off", "Big_Cunt", "NaziGeneral", "sh1t", "Hitler1945", "f4gg0t"]) expect(handleProblem(bad), bad).toBe("abusive");
  });

  it("picks a valid, unreserved handle for a player who did not choose one", () => {
    for (let i = 0; i < 200; i++) expect(handleProblem(pickHandle())).toBeNull();
    expect(pickHandle(() => 0)).toBe("Envoy-1000");
  });
});
