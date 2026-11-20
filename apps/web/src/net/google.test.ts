import { afterEach, describe, expect, it, vi } from "vitest";
import { drawGoogleButton, forgetGoogleStart } from "./google.js";

/** Google Identity Services as the page sees it, with the callback it was started with kept. */
function fakeGoogle() {
  let callback: ((r: { credential: string }) => void) | null = null;
  const id = {
    initialize: vi.fn((config: { callback: (r: { credential: string }) => void }) => {
      callback = config.callback;
    }),
    renderButton: vi.fn(),
    disableAutoSelect: vi.fn(),
  };
  vi.stubGlobal("window", { google: { accounts: { id } } });
  return { id, answer: (credential: string) => callback?.({ credential }) };
}

const parent = () => ({ replaceChildren: vi.fn(), clientWidth: 300 }) as unknown as HTMLElement;

afterEach(() => {
  forgetGoogleStart();
  vi.unstubAllGlobals();
});

describe("drawGoogleButton", () => {
  it("starts Google once however many buttons are drawn, so a sign-in under way is not cancelled", async () => {
    const google = fakeGoogle();
    const first = vi.fn();
    const second = vi.fn();
    await drawGoogleButton(parent(), "client.apps.googleusercontent.com", first);
    await drawGoogleButton(parent(), "client.apps.googleusercontent.com", second);
    expect(google.id.initialize).toHaveBeenCalledTimes(1);
    expect(google.id.renderButton).toHaveBeenCalledTimes(2);
    // The button drawn last hears Google's answer.
    google.answer("token");
    expect(second).toHaveBeenCalledWith("token");
    expect(first).not.toHaveBeenCalled();
  });
});
