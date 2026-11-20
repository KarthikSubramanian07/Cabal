import { describe, expect, it, vi } from "vitest";
import { type ContainerLike, type RegistrationLike, type WorkerLike, createUpdater } from "./register.js";

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
