/** E2B Cloud implementation of Kortix's unified sandbox runtime contract. */

import { Sandbox, SandboxNotFoundError, type Sandbox as E2BSandbox } from 'e2b';
import { config, SANDBOX_VERSION } from '../../config';
import { serviceKeyForExternalId } from '../service-key';
import { sandboxFrontendBaseUrl } from '../sandbox-frontend-url';
import type {
  CreateSandboxOpts,
  ProviderName,
  ProvisioningStatus,
  ProvisioningTraits,
  ProvisionResult,
  ResolvedEndpoint,
  ResolvedSandboxIngress,
  SandboxIngressRequest,
  SandboxProvider,
  SandboxStatus,
} from './index';

// One hour is the maximum accepted by every E2B plan (Pro permits 24 hours).
// Kortix's own idle reaper normally pauses much sooner; this is the provider
// backstop and must not make sandbox creation plan-dependent.
const E2B_RUNTIME_BACKSTOP_MS = 60 * 60 * 1000;
const KORTIX_ENTRYPOINT = '/usr/local/bin/kortix-entrypoint';
const RUNTIME_ENV_PATH = '/etc/kortix/runtime-env.json';
const KORTIX_HEALTH_WAIT =
  'for attempt in $(seq 1 180); do ' +
  'if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:8000/kortix/health >/dev/null; then exit 0; fi; ' +
  'sleep 1; done; exit 1';
const MANAGED_METADATA = 'kortix_managed';
const ENV_METADATA = 'kortix_env';

function apiOpts() {
  return { apiKey: config.E2B_API_KEY, requestTimeoutMs: 20_000 } as const;
}

function isMissingSandboxError(error: unknown): boolean {
  if (error instanceof SandboxNotFoundError) return true;
  const err = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown } | null;
  if (err?.status === 404 || err?.statusCode === 404 || err?.code === 404) return true;
  return /not found|does not exist|no such sandbox/i.test(String(err?.message ?? error ?? ''));
}

/**
 * Traffic tokens are returned on create/connect, not by getInfo. Keep the live
 * handle so normal proxy traffic avoids a control-plane round trip; reconnect
 * after API restarts recovers a fresh token and explicitly resumes a paused box.
 */
const connectedSandboxes = new Map<string, E2BSandbox>();

function validateRuntimeEnv(value: unknown, externalId: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[e2b] sandbox ${externalId} has an invalid persisted runtime environment`);
  }
  const envs: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new Error(`[e2b] sandbox ${externalId} has a non-string persisted runtime environment value`);
    }
    envs[key] = item;
  }
  if (!envs.KORTIX_SANDBOX_TOKEN) {
    throw new Error(`[e2b] sandbox ${externalId} persisted runtime environment has no KORTIX_SANDBOX_TOKEN`);
  }
  return envs;
}

async function persistRuntimeEnv(
  sandbox: E2BSandbox,
  envs: Record<string, string>,
): Promise<void> {
  await sandbox.files.write(RUNTIME_ENV_PATH, JSON.stringify(envs), {
    user: 'root',
    requestTimeoutMs: 10_000,
  });
  await sandbox.commands.run(`chmod 600 ${RUNTIME_ENV_PATH}`, {
    user: 'root',
    timeoutMs: 10_000,
  });
}

async function loadRuntimeEnv(sandbox: E2BSandbox): Promise<Record<string, string>> {
  try {
    const raw = await sandbox.files.read(RUNTIME_ENV_PATH, {
      user: 'root',
      requestTimeoutMs: 10_000,
    });
    return validateRuntimeEnv(JSON.parse(raw), sandbox.sandboxId);
  } catch (error) {
    throw new Error(
      `[e2b] cannot restore runtime environment for sandbox ${sandbox.sandboxId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requirePrivateTrafficToken(sandbox: E2BSandbox): string {
  if (!sandbox.trafficAccessToken) {
    throw new Error(
      `[e2b] sandbox ${sandbox.sandboxId} has no private traffic access token`,
    );
  }
  return sandbox.trafficAccessToken;
}

async function ensureKortixEntrypoint(
  sandbox: E2BSandbox,
  envs?: Record<string, string>,
): Promise<void> {
  const processes = await sandbox.commands.list({ requestTimeoutMs: 10_000 });
  const alreadyRunning = processes.some(
    (process) => `${process.cmd} ${process.args.join(' ')}`.includes(KORTIX_ENTRYPOINT),
  );
  if (!alreadyRunning) {
    await sandbox.commands.run(KORTIX_ENTRYPOINT, {
      background: true,
      user: 'root',
      ...(envs ? { envs } : {}),
      timeoutMs: 20_000,
    });
  }
  await sandbox.commands.run(KORTIX_HEALTH_WAIT, {
    user: 'root',
    ...(envs ? { envs } : {}),
    timeoutMs: 190_000,
  });
}

export class E2BProvider implements SandboxProvider {
  readonly name: ProviderName = 'e2b';

  readonly provisioning: ProvisioningTraits = {
    async: false,
    stages: [{ id: 'creating', progress: 50, message: 'Creating E2B sandbox...' }],
  };

  async getProvisioningStatus(): Promise<ProvisioningStatus | null> {
    return null;
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    const template = opts.snapshot ?? config.E2B_TEMPLATE;
    if (!template) {
      throw new Error(
        'E2B create() has no template: pass opts.snapshot or set E2B_TEMPLATE to a ready E2B template.',
      );
    }

    const sandboxApiBase = config.KORTIX_URL
      .replace(/\/+$/, '')
      .replace(/\/v1\/router$/, '')
      .replace(/\/v1$/, '');
    const envVars: Record<string, string> = {
      KORTIX_API_URL: `${sandboxApiBase}/v1`,
      KORTIX_FRONTEND_URL: sandboxFrontendBaseUrl(),
      ...opts.envVars,
    };
    if (!envVars.KORTIX_SANDBOX_TOKEN) {
      throw new Error('[e2b] create() called without KORTIX_SANDBOX_TOKEN — sandbox cannot authenticate to Kortix.');
    }

    const sandbox = await Sandbox.create(template, {
      ...apiOpts(),
      envs: envVars,
      metadata: {
        [MANAGED_METADATA]: 'true',
        [ENV_METADATA]: config.INTERNAL_KORTIX_ENV,
        kortix_account_id: opts.accountId,
        kortix_created_by: opts.userId,
      },
      timeoutMs: E2B_RUNTIME_BACKSTOP_MS,
      secure: true,
      allowInternetAccess: true,
      network: { allowPublicTraffic: false },
      lifecycle: {
        // Persist the sandbox filesystem, not its RAM. E2B cold-boots this
        // same sandbox identity on an explicit connect(), which preserves the
        // workspace without paying for a full-memory snapshot while paused.
        onTimeout: { action: 'pause', keepMemory: false },
        autoResume: false,
      },
    });

    try {
      requirePrivateTrafficToken(sandbox);
    } catch (error) {
      await sandbox.kill({ requestTimeoutMs: 20_000 }).catch(() => false);
      throw error;
    }

    connectedSandboxes.set(sandbox.sandboxId, sandbox);
    try {
      // E2B preserves the filesystem but not Sandbox.create(...envs) across a
      // keepMemory:false pause. Persist the complete per-session environment on
      // the private rootfs so a cold resume (including after an API restart)
      // can relaunch the authenticated daemon. Never put these secrets in E2B
      // metadata or Kortix DB metadata.
      await persistRuntimeEnv(sandbox, envVars);
      await ensureKortixEntrypoint(sandbox, envVars);
    } catch (error) {
      connectedSandboxes.delete(sandbox.sandboxId);
      await sandbox.kill({ requestTimeoutMs: 20_000 }).catch(() => false);
      throw new Error(`[e2b] failed to launch Kortix entrypoint: ${error instanceof Error ? error.message : String(error)}`);
    }

    const externalId = sandbox.sandboxId;
    return {
      externalId,
      baseUrl: `${sandboxApiBase}/v1/p/${externalId}/8000`,
      metadata: {
        provisionedBy: opts.userId,
        e2bSandboxId: externalId,
        template,
        version: SANDBOX_VERSION,
        lifecycle: 'pause-filesystem-explicit-resume',
      },
    };
  }

  async start(externalId: string): Promise<void> {
    try {
      const sandbox = await Sandbox.connect(externalId, {
        ...apiOpts(),
        timeoutMs: E2B_RUNTIME_BACKSTOP_MS,
      });
      connectedSandboxes.set(externalId, sandbox);
      // A filesystem-only pause cold-boots on connect. E2B normally runs the
      // template start command during that boot; this explicit check makes the
      // Kortix runtime invariant independent of provider startup behavior.
      const envVars = await loadRuntimeEnv(sandbox);
      await ensureKortixEntrypoint(sandbox, envVars);
    } catch (error) {
      connectedSandboxes.delete(externalId);
      throw error;
    }
  }

  async stop(externalId: string): Promise<void> {
    const sandbox = connectedSandboxes.get(externalId);
    if (sandbox) await sandbox.pause({ ...apiOpts(), keepMemory: false });
    else await Sandbox.pause(externalId, { ...apiOpts(), keepMemory: false });
    connectedSandboxes.delete(externalId);
  }

  async remove(externalId: string): Promise<void> {
    connectedSandboxes.delete(externalId);
    try {
      await Sandbox.kill(externalId, apiOpts());
    } catch (error) {
      if (!isMissingSandboxError(error)) throw error;
    }
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    try {
      const info = await Sandbox.getInfo(externalId, apiOpts());
      if (info.state === 'running') return 'running';
      if (info.state === 'paused') return 'stopped';
      return 'unknown';
    } catch (error) {
      return isMissingSandboxError(error) ? 'removed' : 'unknown';
    }
  }

  private async connected(externalId: string): Promise<E2BSandbox> {
    const cached = connectedSandboxes.get(externalId);
    if (cached) return cached;
    const sandbox = await Sandbox.connect(externalId, {
      ...apiOpts(),
      timeoutMs: E2B_RUNTIME_BACKSTOP_MS,
    });
    connectedSandboxes.set(externalId, sandbox);
    return sandbox;
  }

  async resolveIngress(
    externalId: string,
    request: SandboxIngressRequest,
  ): Promise<ResolvedSandboxIngress> {
    const sandbox = await this.connected(externalId);
    const headers = {
      'e2b-traffic-access-token': requirePrivateTrafficToken(sandbox),
    };
    return {
      url: `https://${sandbox.getHost(request.port)}`.replace(/\/$/, ''),
      headers,
      effectivePort: request.port,
    };
  }

  routeIngress(request: SandboxIngressRequest) {
    return { effectivePort: request.port };
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    const ingress = await this.resolveIngress(externalId, { port: 8000, transport: 'http' });
    const headers: Record<string, string> = { ...ingress.headers, 'Content-Type': 'application/json' };
    const serviceKey = await serviceKeyForExternalId(externalId).catch(() => null);
    if (serviceKey) headers.Authorization = `Bearer ${serviceKey}`;
    return { url: ingress.url, headers };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const status = await this.getStatus(externalId);
    if (status === 'running') return;
    if (status === 'stopped') await this.start(externalId);
  }

  async listManagedRunningSandboxes(): Promise<Array<{ externalId: string; createdAt: Date | null }>> {
    const paginator = Sandbox.list({
      ...apiOpts(),
      limit: 100,
      query: {
        metadata: { [MANAGED_METADATA]: 'true', [ENV_METADATA]: config.INTERNAL_KORTIX_ENV },
        state: ['running'],
      },
    });
    const result: Array<{ externalId: string; createdAt: Date | null }> = [];
    while (paginator.hasNext) {
      for (const sandbox of await paginator.nextItems(apiOpts())) {
        result.push({ externalId: sandbox.sandboxId, createdAt: sandbox.startedAt ?? null });
      }
    }
    return result;
  }
}
