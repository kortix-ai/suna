import { describe, expect, test } from "bun:test";

import { resolveSessionPin } from "./initial-session-pin";

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
