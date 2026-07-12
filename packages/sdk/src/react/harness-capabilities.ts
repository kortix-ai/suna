import type { Agent } from "../core/runtime/wire-types";

export type KortixHarness = "claude" | "codex" | "opencode" | "pi";
export type AgentModelPolicy = "catalog" | "harness";

export function agentHarness(
  agent: Agent | null | undefined,
): KortixHarness | null {
  const harness = agent?.harness;
  return harness === "claude" ||
    harness === "codex" ||
    harness === "opencode" ||
    harness === "pi"
    ? harness
    : null;
}

/** Legacy/unknown agents retain the existing catalog requirement. Claude,
 * Codex, and Pi own their default model natively; sending a gateway model
 * override to those adapters is both unnecessary and frequently invalid. */
export function agentModelPolicy(
  agent: Agent | null | undefined,
): AgentModelPolicy {
  const harness = agentHarness(agent);
  return harness === "claude" || harness === "codex" || harness === "pi"
    ? "harness"
    : "catalog";
}

export function agentRequiresCatalogModel(
  agent: Agent | null | undefined,
): boolean {
  return agentModelPolicy(agent) === "catalog";
}
