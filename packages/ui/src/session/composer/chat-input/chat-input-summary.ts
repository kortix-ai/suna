/**
 * What the `chat_input` control says at rest, as pure functions so the rule
 * is testable without React.
 *
 * The control names the agent and the model it runs on, then only what is
 * overridden beyond that:
 *
 *   nothing overridden            → "My Kortix · GLM 5.3 Flash"
 *   effort overridden             → "My Kortix · GLM 5.3 Flash · High"
 *   secrets / keys / sandbox set  → "My Kortix · GLM 5.3 Flash · 2"
 *
 * The model is always named: it is what a person checks at a glance. Effort
 * is named only when it is not the model's own. The settings behind "More
 * settings" (secrets, provider keys, sandbox, files) have no one-word value,
 * so they are counted.
 */

export type ChatInputModelKey = { providerID: string; modelID: string };

/** The parts after the agent on the closed trigger, in order. */
export function chatInputTriggerParts(input: {
  /** The model's name; null when the composer shows no model. */
  model: string | null;
  /** The effort's label when it is overridden; null on Auto. */
  effort: string | null;
  /** How many "More settings" rows are overridden. */
  extras: number;
}): string[] {
  return [
    ...(input.model ? [input.model] : []),
    ...(input.effort ? [input.effort] : []),
    ...(input.extras > 0 ? [String(input.extras)] : []),
  ];
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

/**
 * Which agent the control names, and which agents it offers.
 *
 * `fixed`: the composer is bound to one agent it may not leave (a DM: the
 * space's agent; the host passes no `onAgentChange`). The control names that
 * agent, whatever the person picked elsewhere last, and offers no list. Else
 * it names the selection (or the first agent) and offers every agent, My
 * Kortix first, the same order the agent picker uses.
 */
export function chatInputAgents(
  agentNames: readonly string[],
  selected: string | null,
  fixed: boolean,
  isMyKortix: (name: string) => boolean,
): { name: string | null; offered: string[] } {
  if (fixed) return { name: selected ?? agentNames[0] ?? null, offered: [] };
  const name = (selected && agentNames.includes(selected) ? selected : null) ?? selected ?? agentNames[0] ?? null;
  return { name, offered: [...agentNames.filter(isMyKortix), ...agentNames.filter((agent) => !isMyKortix(agent))] };
}
