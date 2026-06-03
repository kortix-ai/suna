/**
 * Platinum implementation of `SandboxProviderAdapter`.
 *
 * Platinum templates ARE the "snapshots" (GET/DELETE /v1/templates). Building
 * does exactly what Daytona does — ship the staged build context (user
 * Dockerfile + Kortix runtime layer) to the provider and let it build
 * server-side. Daytona uses Image.fromDockerfile(); Platinum uses
 * `POST /v1/templates/from-build` (tar.gz of the same context staged by
 * snapshots/build-context.ts, so the produced image is identical). Platinum's
 * host then runs `podman build` + bakes its microVM init/agent, same as its
 * from-spec path.
 */

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { platinumJson, isPlatinumConfigured } from '../../shared/platinum';
import {
  stageBuildContext,
  DEFAULT_CPU,
  DEFAULT_MEMORY_GB,
  DEFAULT_DISK_GB,
  KORTIX_ENTRYPOINT,
} from '../build-context';
import type {
  BuildableTemplate,
  BuildLogTap,
  ProviderState,
  SandboxProviderAdapter,
} from './index';

const ACTIVATE_DEADLINE_MS = 12 * 60 * 1000; // build + activate ceiling
const POLL_MS = 3_000;

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
    default: return 'missing'; // deprecated / absent / unknown
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

  async buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<void> {
    if (!input.image && !input.userDockerfile) {
      throw new Error('PlatinumAdapter.buildSnapshot: neither image nor userDockerfile set');
    }
    const userDockerfile = input.userDockerfile ?? `FROM ${input.image}\n`;
    // Stage the SAME context Daytona builds (Dockerfile + agent/cli/entrypoint/…).
    const ctx = await stageBuildContext(input.snapshotName, userDockerfile);
    const tarPath = join(ctx.contextDir, '..', `${input.snapshotName.replace(/[^a-zA-Z0-9_.-]/g, '_')}.tar.gz`);
    try {
      const tar = Bun.spawn(['tar', '-czf', tarPath, '-C', ctx.contextDir, '.']);
      if ((await tar.exited) !== 0) throw new Error('tar build context failed');

      // Contexts are 100s of MB (baked agent + CLI binaries) — too big for the
      // API gateway's body cap, so upload DIRECTLY to object storage via a
      // presigned PUT (phase 1 + 2), then register the build (phase 3). The
      // build itself still happens server-side on Platinum (podman build).
      console.info(`[snapshots] ${input.snapshotName}: presign + upload build context to Platinum (slug="${input.slug}")`);
      const { upload_url, context_s3_key } = await platinumJson<{ upload_url: string; context_s3_key: string }>(
        '/v1/templates/from-build/presign', { method: 'POST', body: JSON.stringify({}) },
      );
      const put = await fetch(upload_url, { method: 'PUT', body: new Uint8Array(await readFile(tarPath)) });
      if (!put.ok) throw new Error(`build-context S3 upload -> ${put.status} ${(await put.text().catch(() => '')).slice(0, 200)}`);

      await platinumJson<PlatinumTemplate>('/v1/templates/from-build', {
        method: 'POST',
        body: JSON.stringify({
          name: input.snapshotName,
          context_s3_key,
          dockerfile: ctx.dockerfileName,
          size_mb: (input.spec.diskGb ?? DEFAULT_DISK_GB) * 1024,
          default_cpu: input.spec.cpu ?? DEFAULT_CPU,
          default_ram_mb: (input.spec.memoryGb ?? DEFAULT_MEMORY_GB) * 1024,
          default_disk_gb: input.spec.diskGb ?? DEFAULT_DISK_GB,
          entrypoint: (input.entrypoint ?? [KORTIX_ENTRYPOINT]).join(' '),
        }),
      });
      await this.waitForActive(input.snapshotName, tap);
    } finally {
      await rm(ctx.contextDir, { recursive: true, force: true }).catch(() => {});
      await rm(tarPath, { force: true }).catch(() => {});
    }
  }

  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    if (!isPlatinumConfigured()) return 'missing';
    try {
      return mapState((await findTemplateByName(snapshotName))?.state);
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

  private async waitForActive(name: string, tap?: BuildLogTap): Promise<void> {
    const deadline = Date.now() + ACTIVATE_DEADLINE_MS;
    let last = 'unknown';
    while (Date.now() < deadline) {
      const tpl = await findTemplateByName(name).catch(() => null);
      const state = (tpl?.state ?? 'missing').toLowerCase();
      if (state !== last) { last = state; tap?.onLine?.(`template ${name}: ${state}`); }
      if (state === 'ready') return;
      if (state === 'failed') throw new Error(`Platinum template ${name} build failed`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(`Platinum template ${name} did not become ready (last state: ${last})`);
  }
}

export const platinumProvider = new PlatinumAdapter();
