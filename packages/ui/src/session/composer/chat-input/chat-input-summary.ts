/**
 * What the `chat_input` control says at rest, as pure functions so the rule
 * is testable without React.
 *
 * The control names the agent, then what overrides it:
 *
 *   nothing overridden          → "My Kortix · Auto"
 *   only model and/or effort    → "My Kortix · GLM 5.3 Flash · High"
 *   anything else overridden    → "My Kortix · 2 overrides"
 *
 * Model and effort are the two values a person reads at a glance (they were
 * the two chips beside the agent before this control). Secrets, provider keys
 * and the sandbox have no one-word value, so once one of them is set the
 * label counts instead of naming.
 */

export type ChatInputModelKey = { providerID: string; modelID: string };

/** One overridden setting, as the trigger names it. */
export interface ChatInputOverride {
  id: string;
  /** The value the trigger shows when it names overrides. */
  value: string;
  /** Model and effort: named on the trigger. Anything else: counted. */
  glanceable: boolean;
}

export type ChatInputSummary =
  | { kind: 'auto' }
  | { kind: 'values'; values: string[] }
  | { kind: 'count'; count: number };

export function chatInputSummary(overrides: readonly ChatInputOverride[]): ChatInputSummary {
  if (overrides.length === 0) return { kind: 'auto' };
  if (overrides.every((override) => override.glanceable)) {
    return { kind: 'values', values: overrides.map((override) => override.value) };
  }
  return { kind: 'count', count: overrides.length };
}

export function sameModel(
  a: ChatInputModelKey | null | undefined,
  b: ChatInputModelKey | null | undefined,
): boolean {
  return !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID;
}

/**
 * The model row is overridden when the composer's model is not the one the
 * agent resolves to on its own. An unknown inherited model (defaults still
 * loading) never counts as an override: the row would flash "overridden"
 * on every mount.
 */
export function modelIsOverridden(
  selected: ChatInputModelKey | null | undefined,
  inherited: ChatInputModelKey | null | undefined,
): boolean {
  if (!selected || !inherited) return false;
  return !sameModel(selected, inherited);
}

/**
 * The model the selected agent runs on when nothing overrides it.
 *
 * With no explicit pick (`onDefault`) the composer is already on it. With a
 * pick, it is the server's default chain for that agent (agent → project →
 * account → platform), the same `resolveDefaultFor` the composer resolves
 * through. Read from the host's `useSessionModelSelection`, so the control
 * adds no second model state.
 */
export function inheritedModelFor(
  model: {
    onDefault: boolean;
    currentKey: ChatInputModelKey | undefined;
    /** Absent on a bare `useRuntimeLocal` selection (no project defaults). */
    defaults?: { resolveDefaultFor: (agentName: string | undefined) => ChatInputModelKey | undefined };
  },
  agentName: string | null | undefined,
): ChatInputModelKey | null {
  if (model.onDefault) return model.currentKey ?? null;
  return model.defaults?.resolveDefaultFor(agentName ?? undefined) ?? null;
}
