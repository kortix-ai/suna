import { describe, expect, test } from "bun:test";
import {
  AUTO_DEFAULT_MODEL_ID,
  AUTO_MODEL_ENABLED,
  AUTO_MODEL_ID,
  getManagedModel,
  pickAutoModel,
} from "./index";

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

  test("text requests resolve to GLM 5.2 (regardless of size / tools)", () => {
    expect(pickAutoModel("auto", { messages: [msg("hello there")] })).toBe(
      "glm-5.2",
    );
    expect(
      pickAutoModel("auto", {
        messages: [msg("x".repeat(250_000))],
        tools: [{ name: "edit" }],
      }),
    ).toBe("glm-5.2");
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
    expect(getManagedModel("glm-5.2"), "glm-5.2 must exist").toBeDefined();
    expect(
      getManagedModel("claude-sonnet-4.6"),
      "claude-sonnet-4.6 must exist",
    ).toBeDefined();
  });

  test("AUTO_MODEL_ID is the bare synthetic id", () => {
    expect(AUTO_MODEL_ID).toBe("auto");
  });

  test("AUTO is hidden by default; its target is the GLM 5.2 explicit default", () => {
    // The picker hides AUTO for now (explicit opt-in), but the resolution path
    // stays intact — and AUTO's text target IS the explicit default model.
    expect(AUTO_MODEL_ENABLED).toBe(false);
    expect(AUTO_DEFAULT_MODEL_ID).toBe("glm-5.2");
    expect(
      getManagedModel(AUTO_DEFAULT_MODEL_ID),
      "the auto/default target must be a real managed model",
    ).toBeDefined();
    expect(pickAutoModel("auto", { messages: [msg("hi")] })).toBe(
      AUTO_DEFAULT_MODEL_ID,
    );
  });
});
