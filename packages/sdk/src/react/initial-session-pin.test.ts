import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  readPersistedSessionPin,
  resolvePersistedPin,
  resolveSessionPin,
  sessionPinStorageKey,
  writePersistedSessionPin,
} from "./initial-session-pin";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

describe("resolveSessionPin", () => {
  test("uses the server-authorized initial pin before readiness resolves", () => {
    expect(
      resolveSessionPin({
        startPin: null,
        initialPin: "opencode-cached",
        persistedPin: null,
      }),
    ).toBe("opencode-cached");
  });

  test("replaces a stale initial pin with the authoritative start pin", () => {
    expect(
      resolveSessionPin({
        startPin: "opencode-live",
        initialPin: "opencode-cached",
        persistedPin: "opencode-row",
      }),
    ).toBe("opencode-live");
  });

  test("falls back to the persisted session row when no pin was seeded", () => {
    expect(
      resolveSessionPin({
        startPin: null,
        initialPin: null,
        persistedPin: "opencode-row",
      }),
    ).toBe("opencode-row");
  });
});

describe("sessionPinStorageKey", () => {
  test("namespaces by project AND session, so two sessions never collide", () => {
    expect(sessionPinStorageKey("proj-1", "ses-1")).not.toBe(
      sessionPinStorageKey("proj-1", "ses-2"),
    );
    expect(sessionPinStorageKey("proj-1", "ses-1")).not.toBe(
      sessionPinStorageKey("proj-2", "ses-1"),
    );
  });
});

describe("readPersistedSessionPin / writePersistedSessionPin (localStorage stubbed)", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new MemoryStorage();
  });

  afterEach(() => {
    delete (globalThis as any).localStorage;
  });

  test("returns null when nothing was ever written", () => {
    expect(readPersistedSessionPin("proj-1", "ses-1")).toBeNull();
  });

  test("round-trips a written pin, keyed by (projectId, sessionId)", () => {
    writePersistedSessionPin("proj-1", "ses-1", "opencode-cached");
    expect(readPersistedSessionPin("proj-1", "ses-1")).toBe("opencode-cached");
  });

  test("does not leak across a different session under the same project", () => {
    writePersistedSessionPin("proj-1", "ses-1", "opencode-a");
    expect(readPersistedSessionPin("proj-1", "ses-2")).toBeNull();
  });

  test("a later write for the same key overwrites the earlier one — this is the", () => {
    // stale-pin -> correct-pin convergence story at the storage layer: once a
    // session resolves a DIFFERENT canonical id (a rare re-pin, caught by
    // /start), the next mount must read the corrected value, never the stale
    // one it painted with this time.
    writePersistedSessionPin("proj-1", "ses-1", "opencode-stale");
    expect(readPersistedSessionPin("proj-1", "ses-1")).toBe("opencode-stale");

    writePersistedSessionPin("proj-1", "ses-1", "opencode-correct");
    expect(readPersistedSessionPin("proj-1", "ses-1")).toBe("opencode-correct");
  });

  test("never writes a falsy id — an unresolved pin must not overwrite a good one", () => {
    writePersistedSessionPin("proj-1", "ses-1", "opencode-good");
    writePersistedSessionPin("proj-1", "ses-1", null as unknown as string);
    writePersistedSessionPin("proj-1", "ses-1", "");
    expect(readPersistedSessionPin("proj-1", "ses-1")).toBe("opencode-good");
  });

  test("missing projectId/sessionId never throws and never reads/writes", () => {
    expect(() => writePersistedSessionPin("", "ses-1", "opencode-x")).not.toThrow();
    expect(readPersistedSessionPin("", "ses-1")).toBeNull();
  });
});

describe("readPersistedSessionPin / writePersistedSessionPin (no localStorage global)", () => {
  test("read is a safe no-op, never throws", () => {
    expect(() => readPersistedSessionPin("proj-1", "ses-1")).not.toThrow();
    expect(readPersistedSessionPin("proj-1", "ses-1")).toBeNull();
  });

  test("write is a safe no-op, never throws", () => {
    expect(() => writePersistedSessionPin("proj-1", "ses-1", "opencode-x")).not.toThrow();
  });
});

describe("resolvePersistedPin", () => {
  test("prefers the network-verified value once it has loaded", () => {
    expect(
      resolvePersistedPin({ networkPin: "opencode-row", cachedPin: "opencode-cached" }),
    ).toBe("opencode-row");
  });

  test("falls back to the synchronous local cache while the network read is pending", () => {
    expect(resolvePersistedPin({ networkPin: null, cachedPin: "opencode-cached" })).toBe(
      "opencode-cached",
    );
  });

  test("is null when neither source has anything", () => {
    expect(resolvePersistedPin({ networkPin: null, cachedPin: null })).toBeNull();
  });
});

describe("stale-pin convergence (end to end through resolveSessionPin)", () => {
  test("a stale cached pin paints first, then /start's fresh pin wins the same render pass", () => {
    // Mount 1: nothing but a stale local cache from a previous, now-invalid pin.
    const paintedFirst = resolveSessionPin({
      startPin: null,
      initialPin: null,
      persistedPin: resolvePersistedPin({ networkPin: null, cachedPin: "opencode-stale" }),
    });
    expect(paintedFirst).toBe("opencode-stale");

    // /start now resolves — its pin is authoritative and always wins, even
    // over a persisted/cached value that disagrees with it. No permanent
    // wrong-transcript display: the very next render already prefers the
    // fresh id.
    const converged = resolveSessionPin({
      startPin: "opencode-correct",
      initialPin: null,
      persistedPin: resolvePersistedPin({ networkPin: null, cachedPin: "opencode-stale" }),
    });
    expect(converged).toBe("opencode-correct");
  });

  test("a stale cached pin is corrected by the faster REST read even before /start answers", () => {
    const beforeRest = resolveSessionPin({
      startPin: null,
      initialPin: null,
      persistedPin: resolvePersistedPin({ networkPin: null, cachedPin: "opencode-stale" }),
    });
    expect(beforeRest).toBe("opencode-stale");

    const afterRest = resolveSessionPin({
      startPin: null,
      initialPin: null,
      persistedPin: resolvePersistedPin({ networkPin: "opencode-correct", cachedPin: "opencode-stale" }),
    });
    expect(afterRest).toBe("opencode-correct");
  });
});
