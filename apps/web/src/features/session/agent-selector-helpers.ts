import type { Agent } from '@/hooks/runtime/use-runtime-sessions';
import {
  agentHarness,
  harnessPresentation,
  type KortixHarness,
  type ModelsPageRuntimeStatus,
} from '@kortix/sdk/react';

/**
 * Whether the agent picker's row-level "no model connected" dot should show
 * for a harness, given that harness's `useModelsPage().runtimes[].status`
 * (Task 8's per-harness connection status). `ready` (usable) and `checking`
 * (still resolving — showing a dot here would be a false alarm) are the only
 * statuses that suppress it; `missing`, `ambiguous`, `needs-attention`, and
 * `unavailable` all mean the harness has no usable connection right now.
 * `undefined` (no runtime entry resolved for this harness — e.g. no project
 * context wired to the picker yet) is treated as unknown, not disconnected,
 * so the dot never renders on stale/absent data.
 */
export function isHarnessDisconnected(status: ModelsPageRuntimeStatus | undefined): boolean {
  if (!status) return false;
  return status !== 'ready' && status !== 'checking';
}

/** Harnesses whose picker row is allowed to read as the brand rather than the
 *  agent's own name — never OpenCode, whose many named agents ("kortix",
 *  "build", …) always read as themselves. */
const BRANDABLE_HARNESSES: ReadonlyArray<KortixHarness> = ['claude', 'codex', 'pi'];

/**
 * Which harnesses have *earned* their brand label for this agent list.
 *
 * Claude Code, Codex and Pi normally back exactly one agent apiece — the
 * harness itself — so those rows read as the brand ("Claude Code") instead of
 * the raw manifest key ("claude"). That collapse only works while the
 * assumption holds. Point a second agent at the same harness — switching the
 * project default agent's coding agent to Claude Code rewrites `kortix`'s
 * runtime, which the starter manifest already declares a separate `claude`
 * agent for — and the brand stops identifying anything: the picker renders
 * "Claude Code" twice, and no row tells you which is which.
 *
 * So the label is earned per render, not assumed at module scope. A harness
 * keeps its brand only while it owns a single visible agent; the moment it
 * owns two, both of its rows fall back to their own names.
 */
export function brandLabelHarnesses(agents: readonly Agent[]): Set<KortixHarness> {
  const counts = new Map<KortixHarness, number>();
  for (const agent of agents) {
    const harness = agentHarness(agent);
    if (!harness || !BRANDABLE_HARNESSES.includes(harness)) continue;
    counts.set(harness, (counts.get(harness) ?? 0) + 1);
  }
  return new Set(
    [...counts].filter(([, count]) => count === 1).map(([harness]) => harness),
  );
}

/**
 * Drop the harness pass-through agent that the project's default agent has
 * absorbed, so one coding agent never renders as two identical rows.
 *
 * The starter manifest (`packages/starter/templates/base/kortix.yaml`) ships
 * the `kortix` default agent PLUS one bare pass-through agent per brandable
 * harness — `claude`, `codex`, `pi` — each declaring nothing but `runtime:` and
 * the same blanket grants. Those were never meant to coexist on one harness.
 * But Customize → Coding agents implements "what new chats run on" as a
 * one-field write to the DEFAULT AGENT's own block (`setDefaultCodingAgent` in
 * `coding-agents-panel.tsx`: `runtime = <profile>`, and `delete block.agent`
 * for non-OpenCode harnesses) — so picking Codex makes `kortix`'s block
 * byte-identical to `codex`'s. Two names, one behavior, and a picker showing
 * "Kortix" and "Codex" back to back with the same OpenAI mark.
 *
 * The default agent is the one that survives: it's what a session with no
 * explicit agent boots, what `default_agent` and every trigger reference, and
 * it's the row already carrying the checkmark. The pass-through contributes
 * nothing it doesn't — so it's the one that goes, and (because the harness is
 * back down to a single visible agent) `brandLabelHarnesses` then hands the
 * survivor the brand, leaving exactly one row reading "Codex".
 *
 * Deliberately narrow. Only a PASS-THROUGH collapses — an agent whose name is
 * the harness id or its own runtime profile name, i.e. one that is the harness
 * and nothing more. A project-authored agent pointed at the same harness
 * (`reviewer` on Codex) is a real, separate choice and always keeps its row.
 * `keepAgentName` pins whatever the composer is currently on, so a session
 * bound to the pass-through never loses the row under its own checkmark.
 */
export function withoutRedundantHarnessAgents(
  agents: readonly Agent[],
  options: { defaultAgentName?: string | null; keepAgentName?: string | null },
): Agent[] {
  const { defaultAgentName, keepAgentName } = options;
  if (!defaultAgentName) return [...agents];

  const defaultAgent = agents.find((a) => a.name === defaultAgentName);
  const harness = agentHarness(defaultAgent);
  // OpenCode is excluded for the same reason it never brands: its agents are
  // named identities in their own right, not a single harness wearing a name.
  if (!harness || !BRANDABLE_HARNESSES.includes(harness)) return [...agents];

  return agents.filter((agent) => {
    if (agent.name === defaultAgentName || agent.name === keepAgentName) return true;
    if (agentHarness(agent) !== harness) return true;
    return !isHarnessPassthrough(agent, harness);
  });
}

/** An agent that IS its harness rather than an identity on it — the name the
 *  starter (or the coding-agents panel) generates when you simply turn a
 *  harness on. Matches the harness id and the runtime profile name, which is
 *  keyed off the harness id too (`enableCodingAgent` in `coding-agents.ts`). */
function isHarnessPassthrough(agent: Agent, harness: KortixHarness): boolean {
  const runtime = typeof agent.runtime === 'string' ? agent.runtime : null;
  return agent.name === harness || (runtime !== null && agent.name === runtime);
}

/**
 * The name a picker row (or the composer trigger) shows for `agent`, plus
 * whether that name is the harness brand. Callers need the second half:
 * agent names are lowercase manifest keys and get `capitalize` applied, while
 * a brand label is already correctly cased and must not be touched.
 */
export function agentRowLabel(
  agent: Agent | undefined,
  brandHarnesses: ReadonlySet<KortixHarness>,
): { label: string; isBrand: boolean } {
  if (!agent) return { label: 'Agent', isBrand: false };
  const harness = agentHarness(agent);
  return harness && brandHarnesses.has(harness)
    ? { label: harnessPresentation(harness).label, isBrand: true }
    : { label: agent.name, isBrand: false };
}
