'use client';

/**
 * The Models tab — the gate, and nothing else.
 *
 * **The `llmGatewayEnabled` gate is preserved EXACTLY, not re-derived.** The
 * host computes it once as `isLlmGatewayEnabled(project)`
 * (`capabilities/models/models-page.tsx`) and threads it down; this tab renders
 * `null` while it is false, mirroring the legacy panel's
 * `if (section.startsWith('llm-') && !llmGatewayEnabled) return null;` — nothing
 * (not the placeholder), same as before. It is a DIFFERENT flag from
 * `llmGatewayAvailable`, which gates the rail row only; do not substitute one
 * for the other.
 *
 * **The page itself is `LlmManagementView` (`gateway-view.tsx`).** It renders
 * `CapabilityPageShell` — the same shell Connectors, Agents, Skills, Triggers
 * and Secrets use — with the seven-tab strip in the shell's `filters` slot, the
 * project-default model picker in its `action` slot, and the selected section
 * as its `children`.
 *
 * There is no `ModelsTabView` any more, and this file renders no chrome. It had
 * one: a pass-through that took `LlmManagementView` as a `gatewaySlot` and put
 * it inside a `CapabilityPageShell` here — while `LlmManagementView` built a
 * SECOND shell of its own inside it (its own tab root, its own bordered tab
 * row, its own per-panel scrollers). Two shells for one page is what made
 * Models look like a different product beside its five siblings; the page owns
 * its shell now, and this file owns only the flag.
 *
 * `ModelsTab` is the container: it only exists once this tab is active, which
 * the route guarantees, so nothing here fetches before the page opens.
 */

import { LlmManagementView } from '@/features/workspace/customize/sections/gateway-view';

/** Renders nothing at all while the gateway is disabled. */
export function ModelsTab({
  projectId,
  llmGatewayEnabled,
}: {
  projectId: string;
  llmGatewayEnabled: boolean;
}) {
  if (!llmGatewayEnabled) return null;
  return <LlmManagementView projectId={projectId} />;
}
