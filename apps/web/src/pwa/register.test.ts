import { describe, expect, it, vi } from "vitest";
import { type ContainerLike, type RegistrationLike, type WorkerLike, connect, createUpdater } from "./register.js";

class FakeWorker implements WorkerLike {
  state = "installing";
  messages: unknown[] = [];
  private listeners: (() => void)[] = [];
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  addEventListener(_: "statechange", listener: () => void) {
    this.listeners.push(listener);
  }
  become(state: string) {
    this.state = state;
    for (const l of this.listeners) l();
  }
}

class FakeRegistration implements RegistrationLike {
  waiting: WorkerLike | null = null;
  installing: WorkerLike | null = null;
  private listeners: (() => void)[] = [];
  update = vi.fn(async () => undefined);
  addEventListener(_: "updatefound", listener: () => void) {
    this.listeners.push(listener);
  }
  found(worker: FakeWorker) {
    this.installing = worker;
    for (const l of this.listeners) l();
  }
}

class FakeContainer implements ContainerLike {
  controller: unknown = null;
  private listeners: (() => void)[] = [];
  register = vi.fn();
  addEventListener(_: "controllerchange", listener: () => void) {
    this.listeners.push(listener);
  }
  changeController() {
    this.controller = {};
    for (const l of this.listeners) l();
  }
}

describe("the update prompt", () => {
  it("stays quiet on the first install, and the first claim does not reload the page", () => {
    const container = new FakeContainer();
    const reload = vi.fn();
    const updater = createUpdater(container, reload);
    const reg = new FakeRegistration();
    updater.watch(reg);
    const first = new FakeWorker();
    reg.found(first);
    first.become("installed");
    expect(updater.get().waiting).toBe(false);
    container.changeController();
    expect(reload).not.toHaveBeenCalled();
  });

  it("offers a build that installed behind the one in charge, and reloads only once it takes over", () => {
    const container = new FakeContainer();
    container.controller = {};
    const reload = vi.fn();
    const updater = createUpdater(container, reload);
    const seen = vi.fn();
    updater.subscribe(seen);
    const reg = new FakeRegistration();
    updater.watch(reg);
    const next = new FakeWorker();
    reg.found(next);
    next.become("installed");
    expect(updater.get().waiting).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);

    updater.apply();
    expect(next.messages).toEqual([{ type: "SKIP_WAITING" }]);
    expect(reload).not.toHaveBeenCalled();
    container.changeController();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("offers a build already waiting when the page loads", () => {
    const container = new FakeContainer();
    container.controller = {};
    const updater = createUpdater(container, vi.fn());
    const reg = new FakeRegistration();
    reg.waiting = new FakeWorker();
    updater.watch(reg);
    expect(updater.get().waiting).toBe(true);
    updater.dismiss();
    expect(updater.get().waiting).toBe(false);
  });

  it("ignores a registration that resolved with nothing, as a browser with workers blocked gives", () => {
    const updater = createUpdater(new FakeContainer(), vi.fn());
    expect(() => updater.watch(undefined)).not.toThrow();
    expect(updater.get().waiting).toBe(false);
  });
});

describe("connecting the worker", () => {
  function deps(register: ContainerLike["register"]) {
    const container = new FakeContainer();
    container.register.mockImplementation(register);
    const updater = createUpdater(container, vi.fn());
    const watch = vi.spyOn(updater, "watch");
    const checks: (() => void)[] = [];
    const warn = vi.fn();
    return {
      container,
      watch,
      checks,
      warn,
      deps: { container, updater, every: (check: () => void) => checks.push(check), onVisible: (check: () => void) => checks.push(check), warn },
    };
  }

  it("watches the registration and checks it for updates", async () => {
    const reg = new FakeRegistration();
    const t = deps(async () => reg);
    await connect(t.deps);
    expect(t.watch).toHaveBeenCalledWith(reg);
    for (const check of t.checks) check();
    expect(reg.update).toHaveBeenCalledTimes(2);
    expect(t.warn).not.toHaveBeenCalled();
  });

  it("takes a registration that resolves to nothing as no worker, without throwing", async () => {
    // Playwright's blocked service worker resolves register() to undefined; reading `.waiting`
    // from it used to throw "Cannot read properties of undefined (reading 'waiting')".
    const t = deps(async () => undefined as unknown as RegistrationLike);
    await expect(connect(t.deps)).resolves.toBeUndefined();
    expect(t.watch).not.toHaveBeenCalled();
    expect(t.checks).toHaveLength(0);
    expect(t.warn).toHaveBeenCalledTimes(1);
  });

  it("survives a registration without update()", async () => {
    const reg = new FakeRegistration() as Partial<FakeRegistration>;
    delete reg.update;
    const t = deps(async () => reg as RegistrationLike);
    await connect(t.deps);
    expect(() => t.checks.forEach((check) => check())).not.toThrow();
  });

  it("says why when the browser refuses", async () => {
    const t = deps(async () => {
      throw new Error("denied");
    });
    await expect(connect(t.deps)).resolves.toBeUndefined();
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("could not be set up"), expect.any(Error));
  });
});
