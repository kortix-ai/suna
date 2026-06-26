import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS,
  DEFAULT_MANAGED_MODEL_IDS,
  MANAGED_FLAGSHIP_MODEL_ID,
  MANAGED_MODELS,
  getManagedModel,
  isManagedModelId,
} from "./index";

describe("managed catalog", () => {
  test("exposes the managed lineup", () => {
    expect(DEFAULT_MANAGED_MODEL_IDS).toEqual([
      "claude-opus-4.8",
      "claude-sonnet-4.6",
      "fusion",
      "qwen3.7-max",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      ...DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS,
    ]);
  });

  test("the haiku/sonnet branded ids are gone from the served catalog", () => {
    expect(DEFAULT_MANAGED_MODEL_IDS).not.toContain("kortix-power");
    expect(DEFAULT_MANAGED_MODEL_IDS).not.toContain("kortix-basic");
  });

  test("Opus is the single flagship", () => {
    expect(MANAGED_FLAGSHIP_MODEL_ID).toBe("claude-opus-4.8");
    expect(MANAGED_MODELS.filter((m) => m.tier === "flagship")).toHaveLength(1);
  });

  test("every model has an upstream id, transport, and pricing ref", () => {
    for (const m of MANAGED_MODELS) {
      expect(
        m.upstreamModelId.length,
        `${m.id} needs an upstream id`,
      ).toBeGreaterThan(0);
      expect(
        m.pricingRef.length,
        `${m.id} needs a pricing ref`,
      ).toBeGreaterThan(0);
      expect(["bedrock", "openrouter", "opencode-zen"]).toContain(m.transport);
    }
  });

  test("transport matches the upstream id shape", () => {
    for (const m of MANAGED_MODELS) {
      if (m.transport === "bedrock") {
        // Bedrock managed models are Claude via the Anthropic InvokeModel transport.
        expect(m.upstreamModelId, `${m.id} (Bedrock) → Anthropic`).toContain(
          "anthropic.claude",
        );
      } else if (m.transport === "openrouter") {
        // OpenRouter slugs are provider/model.
        expect(m.transport, `${m.id} transport`).toBe("openrouter");
        expect(m.upstreamModelId, `${m.id} OpenRouter slug`).toContain("/");
      } else {
        expect(m.transport, `${m.id} transport`).toBe("opencode-zen");
        expect(m.upstreamModelId, `${m.id} Zen id`).not.toContain("/");
      }
    }
  });

  test("curated OpenCode Zen free ids are managed Kortix models", () => {
    expect(DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS).toEqual([
      "deepseek-v4-flash-free",
      "mimo-v2.5-free",
      "nemotron-3-ultra-free",
      "north-mini-code-free",
    ]);
    expect(DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS).not.toContain("big-pickle");
    expect(DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS).not.toContain(
      "qwen3.6-plus-free",
    );
    expect(DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS).not.toContain(
      "minimax-m3-free",
    );

    for (const id of DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS) {
      const model = getManagedModel(id);
      expect(model, `${id} should resolve`).toBeDefined();
      expect(model?.transport).toBe("opencode-zen");
      expect(model?.upstreamModelId).toBe(id);
      expect(model?.tier).toBe("free");
      expect(model?.free).toBe(true);
    }
  });
});

describe("managed resolution + back-compat aliases", () => {
  test("resolves current ids", () => {
    expect(getManagedModel("claude-opus-4.8")?.name).toBe("Claude Opus 4.8");
    expect(getManagedModel("claude-opus-4.8")?.transport).toBe("bedrock");
    expect(getManagedModel("fusion")?.transport).toBe("openrouter");
    expect(getManagedModel("fusion")?.upstreamModelId).toBe(
      "openrouter/fusion",
    );
    expect(getManagedModel("qwen3.7-max")?.upstreamModelId).toBe(
      "qwen/qwen3.7-max",
    );
    expect(getManagedModel("deepseek-v4-pro")?.upstreamModelId).toBe(
      "deepseek/deepseek-v4-pro",
    );
  });

  test("retired / superseded model ids no longer resolve (aliases removed)", () => {
    for (const old of [
      "kortix-power",
      "kortix-basic",
      "glm-4.6",
      "glm-5.1",
      "glm-5.2",
      "qwen3-max",
      "minimax-m2.5",
      "kimi-k2",
    ]) {
      expect(getManagedModel(old), `${old} should be gone`).toBeUndefined();
      expect(isManagedModelId(old), `${old} should be gone`).toBe(false);
    }
  });

  test("a BYOK provider/model string is never treated as managed", () => {
    expect(isManagedModelId("anthropic/claude-opus-4.8")).toBe(false);
    expect(getManagedModel("anthropic/claude-opus-4.8")).toBeUndefined();
    expect(isManagedModelId("deepseek/deepseek-v3.2")).toBe(false);
  });

  test("unknown ids do not resolve", () => {
    expect(getManagedModel("nope")).toBeUndefined();
    expect(isManagedModelId("nope")).toBe(false);
  });
});
