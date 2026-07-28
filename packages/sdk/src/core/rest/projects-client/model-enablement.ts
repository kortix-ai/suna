import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ── Per-project model enablement (opt-out, gateway-enforced) ───────────────
// The disabled set is server-owned: the gateway refuses these wire models
// everywhere and the picker hides them. `GET /projects/:id/model-picker`
// returns the current `disabledModels`; this replaces it wholesale.

/** Replace the project's disabled-model set. Empty array = every model enabled. */
export async function setProjectModelEnablement(projectId: string, disabledModels: string[]) {
  return unwrap(
    await backendApi.put<{ ok: boolean; disabledModels: string[] }>(
      `/projects/${projectId}/model-enablement`,
      { disabledModels },
    ),
  );
}
