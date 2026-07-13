import type { Agent } from "../core/runtime/wire-types";

export type KortixHarness = "claude" | "codex" | "opencode" | "pi";
export type AgentModelPolicy = "catalog" | "harness";

export interface HarnessPresentation {
  id: KortixHarness;
  label: string;
  shortLabel: string;
  description: string;
  /** Placeholder only. The actual default stays owned by the selected harness. */
  customModelPlaceholder: string;
}

const HARNESS_PRESENTATION: Record<KortixHarness, HarnessPresentation> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    shortLabel: "Claude",
    description: "Anthropic's coding harness, connected over ACP.",
    customModelPlaceholder: "e.g. claude-sonnet-4-6",
  },
  codex: {
    id: "codex",
    label: "Codex",
    shortLabel: "Codex",
    description: "OpenAI's coding harness, connected over ACP.",
    customModelPlaceholder: "e.g. openai/gpt-5.4",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    shortLabel: "OpenCode",
    description: "Model-agnostic OpenCode harness, connected over ACP.",
    customModelPlaceholder: "provider/model",
  },
  pi: {
    id: "pi",
    label: "Pi",
    shortLabel: "Pi",
    description: "Pi coding agent with its ACP adapter.",
    customModelPlaceholder: "e.g. gpt-5.4",
  },
};

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

export function harnessPresentation(
  harness: KortixHarness,
): HarnessPresentation {
  return HARNESS_PRESENTATION[harness];
}

export function agentHarnessPresentation(
  agent: Agent | null | undefined,
): HarnessPresentation | null {
  const harness = agentHarness(agent);
  return harness ? harnessPresentation(harness) : null;
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
