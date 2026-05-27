/**
 * Daytona sandbox provider.
 *
 * Creates sandboxes in Daytona Cloud from a pre-built snapshot.
 * Extracted from the original account.ts provisioning logic.
 */

import { eq } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { getDaytona } from '../../shared/daytona';
import { db } from '../../shared/db';
import { config, SANDBOX_VERSION } from '../../config';
// (DAYTONA_SNAPSHOT was removed — every sandbox boots from its project's
// own per-project snapshot, resolved by the snapshot builder. Callers
// must pass `opts.snapshot`; there is no shared platform-wide image.)
import type {
  SandboxProvider,
  ProviderName,
  CreateSandboxOpts,
  ProvisionResult,
  SandboxStatus,
  ResolvedEndpoint,
  ProvisioningTraits,
  ProvisioningStatus,
} from './index';

export class DaytonaProvider implements SandboxProvider {
  readonly name: ProviderName = 'daytona';

  readonly provisioning: ProvisioningTraits = {
    async: false,
    stages: [
      { id: 'creating', progress: 50, message: 'Creating sandbox...' },
    ],
  };

  async getProvisioningStatus(): Promise<ProvisioningStatus | null> {
    return null;
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    // Prefer the ad-hoc declarative image path. Named Daytona snapshots have
    // proven non-durable in local testing: snapshot.create can report active
    // while the snapshot is absent from REST/list and a fresh SDK lookup.
    // The ad-hoc path avoids that registry dependency and uses Daytona's
    // per-runner build cache for repeat sessions.
    const snapshot = opts.snapshot;
    const image = opts.image;
    if (!snapshot && !image) {
      throw new Error(
        'Daytona create() called without opts.snapshot or opts.image. ' +
        'Every sandbox must boot from a project image prepared by the builder.',
      );
    }

    const daytona = getDaytona();

    // KORTIX_URL is the public API base URL the sandbox calls back on. Strip
    // any route suffix so older env files that included /v1 or /v1/router still
    // resolve to the bare origin.
    const sandboxApiBase = config.KORTIX_URL
      .replace(/\/+$/, '')
      .replace(/\/v1\/router$/, '')
      .replace(/\/v1$/, '');

    const createTimeoutSeconds = Math.max(
      1,
      Number.parseInt(process.env.KORTIX_DAYTONA_CREATE_TIMEOUT_SECONDS || '120', 10) || 120,
    );

    const daytonaSandbox = await daytona.create(
      {
        ...(snapshot ? { snapshot } : { image }),
        ...(opts.resources ? { resources: opts.resources } : {}),
        envVars: {
          // Session identity, git context, KORTIX_API_URL + KORTIX_TOKEN, and
          // the project's own secrets (incl. provider keys set via `kortix
          // providers`, picked up by opencode at boot) — see
          // buildSessionSandboxEnvVars() and provisionSessionSandbox().
          ...opts.envVars,
        },
        autoStopInterval: 15,
        autoArchiveInterval: 30,
        public: false,
      },
      { timeout: createTimeoutSeconds },
    );

    const externalId = daytonaSandbox.id;
    const apiBase = sandboxApiBase;
    const baseUrl = `${apiBase}/v1/p/${externalId}/8000`;

    return {
      externalId,
      baseUrl,
      metadata: {
        provisionedBy: opts.userId,
        daytonaSandboxId: externalId,
        ...(snapshot ? { snapshot } : { image: 'adhoc' }),
        version: SANDBOX_VERSION,
      },
    };
  }

  async start(externalId: string): Promise<void> {
    const daytona = getDaytona();
    const sandbox = await daytona.get(externalId);
    await sandbox.start();
  }

  async stop(externalId: string): Promise<void> {
    const daytona = getDaytona();
    const sandbox = await daytona.get(externalId);
    await sandbox.stop();
  }

  async remove(externalId: string): Promise<void> {
    const daytona = getDaytona();
    const sandbox = await daytona.get(externalId);
    await daytona.delete(sandbox);
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    try {
      const daytona = getDaytona();
      const sandbox = await daytona.get(externalId);
      const state = String(sandbox.state ?? '').toLowerCase();
      if (state.includes('start') || state.includes('running') || state.includes('active')) return 'running';
      if (state.includes('stop') || state.includes('archive')) return 'stopped';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    const daytona = getDaytona();
    const sandbox = await daytona.get(externalId);
    const link = await (sandbox as any).getPreviewLink(8000);
    const url = (link.url || String(link)).replace(/\/$/, '');
    const token = link.token || null;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Daytona-Skip-Preview-Warning': 'true',
      'X-Daytona-Disable-CORS': 'true',
    };
    if (token) {
      headers['X-Daytona-Preview-Token'] = token;
    }

    // Look up the service key from config.serviceKey so we can authenticate to the sandbox.
    try {
      const [row] = await db
        .select({ config: sandboxes.config })
        .from(sandboxes)
        .where(eq(sandboxes.externalId, externalId))
        .limit(1);
      const serviceKey = (row?.config as Record<string, unknown>)?.serviceKey as string | undefined;
      if (serviceKey) {
        headers['Authorization'] = `Bearer ${serviceKey}`;
      }
    } catch (err) {
      console.warn(`[DAYTONA] Failed to look up service key for ${externalId}:`, err);
    }

    return { url, headers };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const status = await this.getStatus(externalId);
    if (status === 'running') return;
    console.log(`[DAYTONA] Sandbox ${externalId} is ${status}, waking up...`);
    await this.start(externalId);
  }
}
