import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ── Per-project model enablement (display-only) ───────────────────────────
// The newest model of each family is offered by default; a project stores only
// the EXCEPTIONS it made to that. `GET /projects/:id/model-picker` resolves the
// two and stamps `enabled` onto every model it serves, so clients never
// recompute enablement — they read the flag and PUT exceptions. The gateway
// never refuses a request over enablement; it governs offering, not serving.

/**
 * Replace the project's model overrides (`wireModelId -> enabled`). An empty
 * object clears every exception, restoring the pure catalog default.
 */
export async function setWorkspaceModelEnablement(
  projectId: string,
  modelOverrides: Record<string, boolean>,
) {
  return unwrap(
    await backendApi.put<{ ok: boolean; modelOverrides: Record<string, boolean> }>(
      `/workspaces/${projectId}/model-enablement`,
      { modelOverrides },
    ),
  );
}

/** @deprecated Use `setWorkspaceModelEnablement`. Kept permanently. */
export const setProjectModelEnablement = setWorkspaceModelEnablement;
