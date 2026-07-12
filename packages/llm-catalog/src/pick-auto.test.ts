import { describe, expect, test } from "bun:test";
import {
  AUTO_DEFAULT_MODEL_ID,
  AUTO_MODEL_ENABLED,
  AUTO_MODEL_ID,
  DEFAULT_MODEL_FALLBACK_POLICY,
  getManagedModel,
  pickAutoModel,
  routeDefaultModelFallbacks,
} from "./index";

const msg = (content: string) => ({ role: "user", content });

describe("pickAutoModel", () => {
  test("platform default is Codex GPT-5.6 Sol with a bounded GLM 5.2 fallback", () => {
    expect(AUTO_DEFAULT_MODEL_ID).toBe("codex/gpt-5.6-sol");
    expect(DEFAULT_MODEL_FALLBACK_POLICY).toEqual({
      primary: "codex/gpt-5.6-sol",
      fallbacks: ["glm-5.2"],
      fallbackOn: "any-error",
    });
    expect(routeDefaultModelFallbacks("codex/gpt-5.6-sol")).toEqual({
      fallbackModels: ["glm-5.2"],
      fallbackOn: "any-error",
    });
    expect(routeDefaultModelFallbacks("glm-5.2")).toBeNull();
  });
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

  test("text requests resolve to Codex GPT-5.6 (regardless of size / tools)", () => {
    expect(pickAutoModel("auto", { messages: [msg("hello there")] })).toBe(
      "codex/gpt-5.6-sol",
    );
    expect(
      pickAutoModel("auto", {
        messages: [msg("x".repeat(250_000))],
        tools: [{ name: "edit" }],
      }),
    ).toBe("codex/gpt-5.6-sol");
  });

  test("image requests keep the vision-capable Codex default", () => {
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
    expect(pickAutoModel("auto", withImage)).toBe("codex/gpt-5.6-sol");
  });

  test("the fallback and managed vision override are real managed models", () => {
    expect(getManagedModel("glm-5.2"), "fallback glm-5.2 must exist").toBeDefined();
    expect(
      getManagedModel("claude-sonnet-4.6"),
      "claude-sonnet-4.6 must exist",
    ).toBeDefined();
  });

  test("AUTO_MODEL_ID is the bare synthetic id", () => {
    expect(AUTO_MODEL_ID).toBe("auto");
  });

  test("AUTO is hidden by default; its target is the Codex explicit default", () => {
    // The picker hides AUTO for now (explicit opt-in), but the resolution path
    // stays intact — and AUTO's text target IS the explicit default model.
    expect(AUTO_MODEL_ENABLED).toBe(false);
    expect(AUTO_DEFAULT_MODEL_ID).toBe("codex/gpt-5.6-sol");
    expect(pickAutoModel("auto", { messages: [msg("hi")] })).toBe(
      AUTO_DEFAULT_MODEL_ID,
    );
  });
});

const imageBody = {
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ],
};

describe("pickAutoModel — account/agent default (gateway source of truth)", () => {
  test("auto resolves to the supplied default over the platform default", () => {
    expect(
      pickAutoModel("auto", { messages: [msg("hi")] }, { defaultModel: "claude-opus-4.8" }),
    ).toBe("claude-opus-4.8");
    // BYOK default (provider/model wire form) is honored verbatim.
    expect(
      pickAutoModel("auto", { messages: [msg("hi")] }, {
        defaultModel: "anthropic/claude-sonnet-4.6",
      }),
    ).toBe("anthropic/claude-sonnet-4.6");
  });

  test("a 'kortix/'-prefixed default is normalized for the managed lookup", () => {
    expect(
      pickAutoModel("auto", { messages: [msg("hi")] }, { defaultModel: "kortix/glm-5.2" }),
    ).toBe("kortix/glm-5.2");
  });

  test("null/undefined/empty default falls back to the platform default", () => {
    expect(pickAutoModel("auto", { messages: [msg("hi")] }, {})).toBe(AUTO_DEFAULT_MODEL_ID);
    expect(
      pickAutoModel("auto", { messages: [msg("hi")] }, { defaultModel: null }),
    ).toBe(AUTO_DEFAULT_MODEL_ID);
    expect(
      pickAutoModel("auto", { messages: [msg("hi")] }, { defaultModel: "" }),
    ).toBe(AUTO_DEFAULT_MODEL_ID);
  });

  test("image overrides a managed TEXT-ONLY default to the vision model", () => {
    // glm-5.2 is text-only → an image must not be silently dropped.
    expect(pickAutoModel("auto", imageBody, { defaultModel: "glm-5.2" })).toBe(
      "claude-sonnet-4.6",
    );
  });

  test("image KEEPS a vision-capable managed default (no override)", () => {
    // claude-opus-4.8 has vision → keep the user's chosen default.
    expect(pickAutoModel("auto", imageBody, { defaultModel: "claude-opus-4.8" })).toBe(
      "claude-opus-4.8",
    );
  });

  test("image KEEPS a BYOK default (we don't second-guess the user's provider)", () => {
    expect(
      pickAutoModel("auto", imageBody, { defaultModel: "anthropic/claude-sonnet-4.6" }),
    ).toBe("anthropic/claude-sonnet-4.6");
  });

  test("a default is never applied to a concrete (non-auto) request", () => {
    expect(
      pickAutoModel("claude-opus-4.8", { messages: [msg("hi")] }, {
        defaultModel: "glm-5.2",
      }),
    ).toBeNull();
  });
});
