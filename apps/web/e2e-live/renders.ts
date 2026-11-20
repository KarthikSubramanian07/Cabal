/**
 * Counting React renders in the production build, where there is no Profiler: React DOM still
 * reports every commit to the developer tools' hook when one is installed before it loads. This
 * installs a stand-in hook that, at each commit, looks up the component that owns a DOM node
 * (the board's `.board-frame`) and records every new props object it has been given. A component
 * that is not memoised receives a fresh props object exactly when its parent renders it again, so
 * the number of distinct props objects seen is the number of times it rendered.
 */
import type { BrowserContext, Page } from "@playwright/test";

declare global {
  interface Window {
    __renders?: Record<string, number>;
  }
}

/** Install the counting hook in every page of `context`, for components owning these selectors. */
export async function countRenders(context: BrowserContext, selectors: Record<string, string>) {
  await context.addInitScript((watch: Record<string, string>) => {
    const counts: Record<string, number> = Object.fromEntries(Object.keys(watch).map((k) => [k, 0]));
    const seen = new WeakSet<object>();
    window.__renders = counts;
    type Fiber = { return: Fiber | null; alternate: Fiber | null; memoizedProps: unknown };
    const owner = (el: Element): Fiber | null => {
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      const host = key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
      return host?.return ?? null;
    };
    const record = () => {
      for (const [name, selector] of Object.entries(watch)) {
        const el = document.querySelector(selector);
        const fiber = el ? owner(el) : null;
        if (!fiber) continue;
        for (const f of [fiber, fiber.alternate]) {
          const props = f?.memoizedProps;
          if (props && typeof props === "object" && !seen.has(props)) {
            seen.add(props);
            counts[name] = (counts[name] ?? 0) + 1;
          }
        }
      }
    };
    let id = 0;
    (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => ++id,
      checkDCE: () => undefined,
      onScheduleFiberRoot: () => undefined,
      onCommitFiberRoot: () => record(),
      onPostCommitFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
    };
  }, selectors);
}

/** How many times each watched component has rendered so far. */
export async function renders(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => ({ ...window.__renders }));
}
