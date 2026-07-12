import { describe, expect, test } from "bun:test";
import type { Agent } from "../core/runtime/wire-types";
import {
  agentHarness,
  agentModelPolicy,
  agentRequiresCatalogModel,
} from "./harness-capabilities";

const agent = (harness?: string): Agent => ({
  name: harness ?? "legacy",
  harness,
});

describe("ACP harness capabilities", () => {
  test.each(["claude", "codex", "pi"])(
    "%s uses its harness-native default model",
    (harness) => {
      expect(agentModelPolicy(agent(harness))).toBe("harness");
      expect(agentRequiresCatalogModel(agent(harness))).toBe(false);
    },
  );

  test("OpenCode and legacy agents retain catalog model gating", () => {
    expect(agentRequiresCatalogModel(agent("opencode"))).toBe(true);
    expect(agentRequiresCatalogModel(agent())).toBe(true);
  });

  test("rejects unknown harness metadata", () => {
    expect(agentHarness(agent("unknown"))).toBeNull();
  });
});
