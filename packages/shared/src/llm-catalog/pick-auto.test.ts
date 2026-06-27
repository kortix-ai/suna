import { describe, expect, test } from "bun:test";
import { AUTO_MODEL_ID, getManagedModel, pickAutoModel } from "./index";

const msg = (content: string) => ({ role: "user", content });

describe("pickAutoModel", () => {
  test("returns null for any non-auto model (pass-through)", () => {
    expect(
      pickAutoModel("claude-opus-4.8", { messages: [msg("hi")] }),
    ).toBeNull();
    expect(pickAutoModel("anthropic/claude-x", {})).toBeNull();
    expect(pickAutoModel("", {})).toBeNull();
  });

  test('accepts both "auto" and "kortix/auto"', () => {
    expect(pickAutoModel("auto", { messages: [msg("hi")] })).not.toBeNull();
    expect(
      pickAutoModel("kortix/auto", { messages: [msg("hi")] }),
    ).not.toBeNull();
  });

  test("text requests resolve to Fusion (regardless of size / tools)", () => {
    expect(pickAutoModel("auto", { messages: [msg("hello there")] })).toBe(
      "fusion",
    );
    expect(
      pickAutoModel("auto", {
        messages: [msg("x".repeat(250_000))],
        tools: [{ name: "edit" }],
      }),
    ).toBe("fusion");
  });

  test("image requests route to a vision model (not blind GLM)", () => {
    const withImage = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
          ],
        },
      ],
    };
    expect(pickAutoModel("auto", withImage)).toBe("claude-sonnet-4.6");
  });

  test("both auto targets are real managed models", () => {
    expect(getManagedModel("fusion"), "fusion must exist").toBeDefined();
    expect(
      getManagedModel("claude-sonnet-4.6"),
      "claude-sonnet-4.6 must exist",
    ).toBeDefined();
  });

  test("free tier does not resolve auto through the managed gateway", () => {
    // A free account's Zen default is a native sandbox `opencode` model, not a
    // Kortix-managed gateway model. Returning null makes raw auto yield no
    // gateway candidate instead of silently using a gateway IP for Zen.
    expect(
      pickAutoModel("auto", { messages: [msg("hello there")] }, { free: true }),
    ).toBeNull();
    const withImage = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
          ],
        },
      ],
    };
    expect(pickAutoModel("auto", withImage, { free: true })).toBeNull();
  });

  test("free Zen defaults are not managed gateway models", () => {
    for (const id of ["deepseek-v4-flash-free", "mimo-v2.5-free"]) {
      expect(getManagedModel(id), `${id} must stay native`).toBeUndefined();
    }
  });

  test("free option does not affect non-auto pass-through", () => {
    expect(
      pickAutoModel("claude-opus-4.8", { messages: [msg("hi")] }, { free: true }),
    ).toBeNull();
  });

  test("AUTO_MODEL_ID is the bare synthetic id", () => {
    expect(AUTO_MODEL_ID).toBe("auto");
  });
});
