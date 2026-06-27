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

  test("free tier resolves auto to a FREE model, never a paid one", () => {
    // Text → free text default; image → the one free vision model. A free
    // account has no upstream for fusion/claude-sonnet, so auto must not pick them.
    expect(
      pickAutoModel("auto", { messages: [msg("hello there")] }, { free: true }),
    ).toBe("deepseek-v4-flash-free");
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
    expect(pickAutoModel("auto", withImage, { free: true })).toBe(
      "mimo-v2.5-free",
    );
  });

  test("both free auto targets are real FREE managed models", () => {
    for (const id of ["deepseek-v4-flash-free", "mimo-v2.5-free"]) {
      const m = getManagedModel(id);
      expect(m, `${id} must exist`).toBeDefined();
      expect(m?.free, `${id} must be free`).toBe(true);
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
