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
    const snapshot = config.DAYTONA_SNAPSHOT;
    if (!snapshot) {
      throw new Error('DAYTONA_SNAPSHOT is not configured — set it to the snapshot name (e.g. kortix-sandbox-v0.4.1)');
    }

    const daytona = getDaytona();

    // Use KORTIX_TOKEN as INTERNAL_SERVICE_KEY — one key for both directions.
    // KORTIX_TOKEN (sandbox → api) is already in opts.envVars.
    // INTERNAL_SERVICE_KEY (api → sandbox) is the same value so the proxy can auth.
    const serviceKey = opts.envVars?.KORTIX_TOKEN || '';

    // Strip /v1/router suffix — opencode.jsonc appends it already.
    // KORTIX_URL may be "https://new-api.kortix.com/v1/router" but the
    // sandbox expects the base: "https://new-api.kortix.com".
    const sandboxApiBase = config.KORTIX_URL.replace(/\/v1\/router\/?$/, '');
    const routerBase = `${sandboxApiBase}/v1/router`;

    const daytonaSandbox = await daytona.create(
      {
        snapshot,
        envVars: {
          KORTIX_API_URL: sandboxApiBase,
          ENV_MODE: 'cloud',
          INTERNAL_SERVICE_KEY: serviceKey,
          TUNNEL_API_URL: sandboxApiBase,
          TUNNEL_TOKEN: serviceKey,
          // Route tool SDK traffic through the Kortix router proxy for billing/key injection.
          // If not set, sandbox tools fall back to hitting the real upstream APIs directly.
          TAVILY_API_URL: `${routerBase}/tavily`,
          REPLICATE_API_URL: `${routerBase}/replicate`,
          SERPER_API_URL: `${routerBase}/serper`,
          FIRECRAWL_API_URL: `${routerBase}/firecrawl`,
          // Only inject CRW proxy URL when backend has CRW key configured
          ...(config.CRW_API_KEY ? { CRW_API_URL: `${routerBase}/crw` } : {}),
          ...opts.envVars,
        },
        autoStopInterval: 15,
        autoArchiveInterval: 30,
        public: false,
      },
      { timeout: 300 },
    );

    const externalId = daytonaSandbox.id;
    const apiBase = config.KORTIX_URL.replace(/\/v1\/router\/?$/, '').replace(/\/v1\/?$/, '');
    const baseUrl = `${apiBase}/v1/p/${externalId}/8000`;

    return {
      externalId,
      baseUrl,
      metadata: {
        provisionedBy: opts.userId,
        daytonaSandboxId: externalId,
        snapshot,
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
