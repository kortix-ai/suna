import { AUTO_MODEL_ID, DEFAULT_MANAGED_MODEL_IDS } from '@kortix/llm-catalog';

import type { FlatModel } from './session-chat-input';

// `auto` is a synthetic managed entry (not a real upstream model): grouped under
// Kortix and — when exposed (see featureFlags.enableAutoModel) — rendered as a
// special "smart routing" affordance rather than a normal list item. It stays in
// this set so it groups under Kortix and is recognised as managed even while the
// toggle is hidden.
const MANAGED_MODEL_IDS = new Set<string>([...DEFAULT_MANAGED_MODEL_IDS, AUTO_MODEL_ID]);

// The gateway exposes its whole catalog through a single `kortix` provider, with
// model ids namespaced as `<provider>/<model>`. For the picker we recover the
// real provider: platform-managed defaults stay under the "Kortix" group, while
// every BYOK model surfaces under its real provider ("Anthropic", "OpenAI", …).
// Prefer the explicit `FlatModel.provider` field; string-split `modelID` only as
// a fallback for a stale catalog that predates that field.
export function pickerGroupId(model: FlatModel): string {
  if (model.providerID !== 'kortix' || MANAGED_MODEL_IDS.has(model.modelID)) {
    return model.providerID;
  }
  if (model.provider) return model.provider;
  const slash = model.modelID.indexOf('/');
  return slash === -1 ? model.providerID : model.modelID.slice(0, slash);
}
