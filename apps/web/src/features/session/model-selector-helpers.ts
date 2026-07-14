import { AUTO_MODEL_ID, DEFAULT_MANAGED_MODEL_IDS } from '@kortix/llm-catalog';

import type { FlatModel } from './session-chat-input';

// `auto` is a synthetic managed entry (not a real upstream model): grouped under
// Kortix and — when exposed (see featureFlags.enableAutoModel) — rendered as a
// special "smart routing" affordance rather than a normal list item. It stays in
// this set so it groups under Kortix and is recognised as managed even while the
// toggle is hidden.
const MANAGED_MODEL_IDS = new Set<string>([...DEFAULT_MANAGED_MODEL_IDS, AUTO_MODEL_ID]);

// The gateway exposes its whole catalog through a single `kortix` provider, with
// model ids namespaced as `<provider>/<model>`. For the picker we split that
// back out: platform-managed defaults stay under the "Kortix" group, while every
// BYOK model surfaces under its real provider ("Anthropic", "OpenAI", …) — so a
// connected provider reads as its own section, not buried in Kortix.
export function pickerGroupId(model: FlatModel): string {
  if (model.providerID !== 'kortix' || MANAGED_MODEL_IDS.has(model.modelID)) {
    return model.providerID;
  }
  const slash = model.modelID.indexOf('/');
  return slash === -1 ? model.providerID : model.modelID.slice(0, slash);
}

/**
 * The popover's one-line "what will this agent run on" context header — only
 * meaningful when every visible model resolves to a single connection/group.
 * Once two or more groups are visible (e.g. Kortix + a connected BYOK
 * provider) there is no one connection to name, so the header is omitted
 * rather than picking one arbitrarily.
 */
export function modelSelectorContextLine(
  groups: Array<{ providerID: string; providerName: string }>,
): string | null {
  if (groups.length !== 1) return null;
  const only = groups[0]!;
  if (only.providerID === 'kortix') return 'via Kortix (included)';
  return `via ${only.providerName}`;
}
