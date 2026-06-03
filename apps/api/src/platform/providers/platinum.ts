/**
 * Platinum sandbox provider.
 *
 * Provisions Cloud Hypervisor microVMs via the Platinum REST API. Mirrors the
 * Daytona provider's contract one-for-one; the only differences are Platinum's
 * request shapes:
 *   - create boots from a per-project TEMPLATE (opts.snapshot = a Platinum
 *     template id/name) with `?wait_for_state=running` so create returns a
 *     running sandbox synchronously (provisioning.async = false, like Daytona).
 *   - the agent port (8000) is reached through Platinum's edge via a PUBLIC
 *     expose URL; the sandbox itself is gated by the KORTIX serviceKey bearer
 *     (added as a header in resolveEndpoint, same effective auth as Daytona).
 */

import { eq } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { platinumJson } from '../../shared/platinum';
import { db } from '../../shared/db';
import { config, SANDBOX_VERSION } from '../../config';
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

const AGENT_PORT = 8000;

interface PlatinumSandbox {
  id: string;
  state?: string;
}
type PlatinumExposedPort = { port: number; url: string; token?: string; public: boolean };

export class PlatinumProvider implements SandboxProvider {
  readonly name: ProviderName = 'platinum';

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
    // Boot from the session's own per-project template if one was built
    // (opts.snapshot), else fall back to the fixed PLATINUM_TEMPLATE (e.g.
    // kortix-computer) — so Platinum works out of the box without a per-project
    // build. At least one must be set.
    const template = opts.snapshot ?? config.PLATINUM_TEMPLATE;
    if (!template) {
      throw new Error(
        'Platinum create() has no template: pass opts.snapshot or set PLATINUM_TEMPLATE ' +
        '(a ready Platinum template id, e.g. kortix-computer).',
      );
    }

    const sandboxApiBase = config.KORTIX_URL
      .replace(/\/+$/, '')
      .replace(/\/v1\/router$/, '')
      .replace(/\/v1$/, '');

    const envVars: Record<string, string> = {
      KORTIX_API_URL: `${sandboxApiBase}/v1`,
      ...opts.envVars,
    };
    if (!envVars.KORTIX_TOKEN) {
      throw new Error('[platinum] create() called without KORTIX_TOKEN — sandbox cannot authenticate to the Kortix router.');
    }

    // autoStopInterval maps to Platinum's auto_stop_minutes. 0 (warm-pool) →
    // persistent (never auto-stops); >0 → ephemeral with that idle timeout.
    const autoStop = opts.autoStopInterval ?? 15;

    const sandbox = await platinumJson<PlatinumSandbox>(
      '/v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000',
      {
        method: 'POST',
        body: JSON.stringify({
          template,
          envVars,
          type: autoStop === 0 ? 'persistent' : 'ephemeral',
          auto_stop_minutes: autoStop,
        }),
      },
    );

    const externalId = sandbox.id;
    const baseUrl = `${sandboxApiBase}/v1/p/${externalId}/${AGENT_PORT}`;

    return {
      externalId,
      baseUrl,
      metadata: {
        provisionedBy: opts.userId,
        platinumSandboxId: externalId,
        template,
        version: SANDBOX_VERSION,
      },
    };
  }

  async start(externalId: string): Promise<void> {
    await platinumJson(`/v1/sandboxes/${externalId}/start`, { method: 'POST' });
  }

  async stop(externalId: string): Promise<void> {
    await platinumJson(`/v1/sandboxes/${externalId}/stop`, { method: 'POST' });
  }

  async remove(externalId: string): Promise<void> {
    await platinumJson(`/v1/sandboxes/${externalId}`, { method: 'DELETE' });
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    try {
      const sandbox = await platinumJson<PlatinumSandbox>(`/v1/sandboxes/${externalId}`);
      const state = String(sandbox.state ?? '').toLowerCase();
      if (state === 'running') return 'running';
      if (state === 'stopped' || state === 'stopping' || state.includes('archiv')) return 'stopped';
      if (state === 'deleted' || state === 'failed-start' || state === 'lost') return 'removed';
      return 'unknown'; // provisioning / starting / resuming / migrating — transitional
    } catch {
      return 'unknown';
    }
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    // Expose the agent port through Platinum's edge. PUBLIC (no HMAC ?t= token)
    // because Platinum's edge reads the token from the query string only, which
    // doesn't compose with the Kortix proxy appending a path — and the sandbox
    // is already gated by the KORTIX serviceKey bearer below (same effective
    // auth as Daytona's preview link + serviceKey). Idempotent: re-exposing an
    // already-exposed port returns the same URL.
    const exposed = await platinumJson<PlatinumExposedPort[]>(
      `/v1/sandboxes/${externalId}/expose`,
      { method: 'POST', body: JSON.stringify({ expose: [{ port: AGENT_PORT, public: true }] }) },
    );
    const url = (exposed.find((e) => e.port === AGENT_PORT)?.url ?? '').replace(/\/$/, '');
    if (!url) throw new Error(`[platinum] expose returned no URL for ${externalId}:${AGENT_PORT}`);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    try {
      const [row] = await db
        .select({ config: sandboxes.config })
        .from(sandboxes)
        .where(eq(sandboxes.externalId, externalId))
        .limit(1);
      const serviceKey = (row?.config as Record<string, unknown>)?.serviceKey as string | undefined;
      if (serviceKey) headers['Authorization'] = `Bearer ${serviceKey}`;
    } catch (err) {
      console.warn(`[PLATINUM] Failed to look up service key for ${externalId}:`, err);
    }

    return { url, headers };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const status = await this.getStatus(externalId);
    if (status === 'running') return;
    // Only a stopped sandbox can be started; poking a transitional one would
    // 409. Anything else we leave to settle / to the reconciler.
    if (status === 'stopped') {
      console.log(`[PLATINUM] Sandbox ${externalId} is stopped, waking up...`);
      await this.start(externalId);
    }
  }
}
