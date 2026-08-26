'use client';

/**
 * The Models tab — the mode fork, and nothing else.
 *
 * **`llmGatewayEnabled` is computed once by the host** as
 * `isLlmGatewayEnabled(project)` (`capabilities/models/models-page.tsx`) and
 * threaded down; this tab forwards it to `LlmManagementView`, which renders
 * the full gateway surface when on and the native key-intake subset
 * (Providers + Custom) when off. It is a DIFFERENT flag from
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

/**
 * Both modes render the page now. Gateway on: the full seven-tab management
 * surface. Gateway off (native OpenCode): the same shell restricted to key
 * intake — Providers + Custom — because provider keys ARE the native model
 * setup (they deliver into the sandbox env and OpenCode auto-connects). The
 * old `return null` here left the Models rail row, hub card, tab route, and
 * ⌘K entry all pointing at a blank page for every native project.
 */
export function ModelsTab({
  projectId,
  llmGatewayEnabled,
}: {
  projectId: string;
  llmGatewayEnabled: boolean;
}) {
  return <LlmManagementView projectId={projectId} llmGatewayEnabled={llmGatewayEnabled} />;
}
