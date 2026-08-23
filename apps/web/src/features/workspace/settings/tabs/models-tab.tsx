'use client';

/**
 * The Models tab — the page, and nothing else.
 *
 * **Models is always on; gateway mode is the only mode.** The retired
 * `llm_gateway` flag used to hide this whole pane (render `null`) for projects
 * without the gateway. There is no second mode any more — every project routes
 * models through the Kortix gateway — so there is nothing to gate on here: not
 * a flag, not an availability bit, not a re-derivation.
 *
 * **The page itself is `LlmManagementView` (`gateway-view.tsx`).** It renders
 * the route guarantees, so nothing here fetches before the page opens.
 */

import { LlmManagementView } from '@/features/workspace/customize/sections/gateway-view';

export function ModelsTab({ projectId }: { projectId: string }) {
  return <LlmManagementView projectId={projectId} />;
}
