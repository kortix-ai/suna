import { describe, expect, test } from "bun:test";

import { confirmCommitted, errorCode, isAmbiguousCreateFailure } from "./ambiguous-write";

describe("isAmbiguousCreateFailure", () => {
  test("a client timeout and a server deadline are ambiguous", () => {
    expect(isAmbiguousCreateFailure("TIMEOUT")).toBe(true);
    expect(isAmbiguousCreateFailure("request_deadline")).toBe(true);
  });

  test("a refusal or a missing code is not ambiguous", () => {
    expect(isAmbiguousCreateFailure("subscription_required")).toBe(false);
    expect(isAmbiguousCreateFailure(undefined)).toBe(false);
  });
});

describe("errorCode", () => {
  test("reads a string code and ignores anything else", () => {
    expect(errorCode({ code: "TIMEOUT" })).toBe("TIMEOUT");
    expect(errorCode({ code: 408 })).toBeUndefined();
    expect(errorCode(new Error("boom"))).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });
});

describe("confirmCommitted", () => {
  const noSleep = async () => {};

  test("stops at the first probe that sees the write", async () => {
    let calls = 0;
    const seen = await confirmCommitted(async () => ++calls === 2, { sleep: noSleep });
    expect(seen).toBe(true);
    expect(calls).toBe(2);
  });

  test("a throwing probe counts as not yet, and gives up after the attempts", async () => {
    let calls = 0;
    const seen = await confirmCommitted(
      async () => {
        calls += 1;
        throw new Error("404");
      },
      { attempts: 3, sleep: noSleep },
    );
    expect(seen).toBe(false);
    expect(calls).toBe(3);
  });
});
