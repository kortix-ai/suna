/**
 * Platinum implementation of `SandboxProviderAdapter`.
 *
 * Platinum templates ARE the "snapshots" (GET/DELETE /v1/templates). State and
 * deletion map cleanly. Building is the open piece: the Kortix snapshot builder
 * layers the runtime (agent binary + entrypoint) onto the image via a Docker
 * BUILD CONTEXT that the provider builds server-side (see snapshots/providers/
 * daytona.ts → Image.fromDockerfile(ctx)). Platinum's template build
 * (POST /v1/templates/from-image | from-spec) pulls a registry image / runs
 * inline Dockerfile steps — it has no way to receive that local build context,
 * so it cannot bake the Kortix runtime today.
 *
 * buildSnapshot() therefore fail-closes with an actionable error instead of
 * producing a template silently missing the agent (which would boot but never
 * connect back to the Kortix router). The path to enable it is one of:
 *   (a) publish the Kortix runtime layer as a registry image and build Platinum
 *       templates `FROM` it via from-spec (the clean, recommended path), or
 *   (b) add build-context upload to Platinum's template build.
 * State/delete are implemented so reconciliation + cleanup already work.
 */

import { platinumJson, isPlatinumConfigured } from '../../shared/platinum';
import type {
  BuildableTemplate,
  BuildLogTap,
  ProviderState,
  SandboxProviderAdapter,
} from './index';

interface PlatinumTemplate {
  id: string;
  name?: string;
  state?: string;
}

/** Platinum template state → the adapter's ProviderState vocabulary. */
function mapState(state: string | undefined): ProviderState {
  switch ((state ?? '').toLowerCase()) {
    case 'ready': return 'active';
    case 'building': return 'building';
    case 'failed': return 'build_failed';
    case 'deprecated':
    case '': return 'missing';
    default: return 'missing';
  }
}

async function findTemplateByName(name: string): Promise<PlatinumTemplate | null> {
  const list = await platinumJson<PlatinumTemplate[]>('/v1/templates');
  return list.find((t) => t.name === name) ?? null;
}

class PlatinumAdapter implements SandboxProviderAdapter {
  readonly id = 'platinum' as const;

  isConfigured(): boolean {
    return isPlatinumConfigured();
  }

  async buildSnapshot(input: BuildableTemplate, _tap?: BuildLogTap): Promise<void> {
    throw new Error(
      `[snapshots] Platinum build for "${input.snapshotName}" is not wired yet. ` +
      'Platinum cannot receive the local Docker build context that bakes the Kortix ' +
      'runtime layer (agent + entrypoint) into the image. Enable it by publishing the ' +
      'Kortix runtime as a registry image and building Platinum templates FROM it via ' +
      'from-spec, or by adding build-context upload to Platinum template builds. ' +
      'See apps/api/src/snapshots/providers/platinum.ts.',
    );
  }

  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    if (!isPlatinumConfigured()) return 'missing';
    try {
      const tpl = await findTemplateByName(snapshotName);
      return mapState(tpl?.state);
    } catch {
      return 'missing';
    }
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    if (!isPlatinumConfigured()) return;
    try {
      const tpl = await findTemplateByName(snapshotName);
      if (!tpl) return;
      await platinumJson(`/v1/templates/${tpl.id}`, { method: 'DELETE' });
    } catch {
      // not found / transient — treat as already gone
    }
  }
}

export const platinumProvider = new PlatinumAdapter();
