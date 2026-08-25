/** E2B Cloud implementation of Kortix's unified sandbox runtime contract. */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { type Sandbox as E2BSandbox, Sandbox, SandboxNotFoundError } from 'e2b';
import { SANDBOX_VERSION, config } from '../../config';
import { configuredTimeoutMs, withTimeout } from '../../shared/with-timeout';
import { sandboxFrontendBaseUrl } from '../sandbox-frontend-url';
import { serviceKeyForExternalId } from '../service-key';
import { e2bDomain } from './e2b-domain';
import type {
  AppMachineSupport,
  CreateSandboxOpts,
  ProviderName,
  ProvisionResult,
  ProvisioningStatus,
  ProvisioningTraits,
  ResolvedEndpoint,
  ResolvedSandboxIngress,
  SandboxIngressRequest,
  SandboxProvider,
  SandboxStatus,
} from './index';
import { assertWorkloadCredential, sandboxWorkloadType } from './index';

// One hour is the maximum accepted by every E2B plan (Pro permits 24 hours).
// Kortix's own idle reaper normally pauses much sooner; this is the provider
// backstop and must not make sandbox creation plan-dependent.
const E2B_RUNTIME_BACKSTOP_MS = configuredTimeoutMs(
  'KORTIX_E2B_RUNTIME_BACKSTOP_MS',
  60 * 60 * 1000,
  60_000,
);
const KORTIX_ENTRYPOINT = '/usr/local/bin/kortix-entrypoint';
const KORTIX_ENTRYPOINT_COMMAND = `exec flock -n /run/kortix-entrypoint.lock ${KORTIX_ENTRYPOINT}`;
const RUNTIME_ENV_PATH = '/etc/kortix/runtime-env.json';
const RUNTIME_ENV_ENVELOPE = 'kortix-e2b-runtime-env-v1';
const RUNTIME_ENV_TAG_LENGTH = 16;
const KORTIX_HEALTH_WAIT =
  'for attempt in $(seq 1 180); do ' +
  'if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:8000/kortix/health >/dev/null; then exit 0; fi; ' +
  'sleep 1; done; exit 1';
const KORTIX_APPD = '/kortix/bin/kortix-appd';
const KORTIX_APPD_COMMAND = `exec flock -n /run/kortix-appd.lock ${KORTIX_APPD}`;
const KORTIX_APPD_HEALTH_WAIT =
  'for attempt in $(seq 1 180); do ' +
  'if curl --fail --silent --show-error --max-time 2 ' +
  '-H "Authorization: Bearer $KORTIX_APPD_TOKEN" ' +
  'http://127.0.0.1:7331/v1/health >/dev/null; then exit 0; fi; ' +
  'sleep 1; done; exit 1';
const MANAGED_METADATA = 'kortix_managed';
const ENV_METADATA = 'kortix_env';
// The E2B SDK accepts requestTimeoutMs, but a live kill call remained pending
// after that budget. This outer timer bounds all permanent-removal call sites.
const E2B_REMOVE_TIMEOUT_MS = configuredTimeoutMs('KORTIX_E2B_REMOVE_TIMEOUT_MS', 25_000, 1_000);
const E2B_RENEW_TIMEOUT_MS = configuredTimeoutMs('KORTIX_E2B_RENEW_TIMEOUT_MS', 25_000, 1_000);
// How far the provider deadline may lag `now + backstop` before a renewal is
// treated as ignored. Renewals run every ~20 s; a 1h team cap shows up as a
// deadline pinned at `startedAt + 1h`, i.e. minutes short within minutes.
const E2B_RENEWAL_TOLERANCE_MS = configuredTimeoutMs(
  'KORTIX_E2B_RENEWAL_TOLERANCE_MS',
  2 * 60 * 1000,
  1_000,
);

/** The provider acknowledged a renewal (204) but its deadline did not move. */
export class E2BLifecycleRenewalIgnoredError extends Error {
  readonly code = 'e2b_lifecycle_renewal_ignored';
  constructor(
    message: string,
    readonly providerEndAtMs: number,
  ) {
    super(message);
    this.name = 'E2BLifecycleRenewalIgnoredError';
  }
}

function parseProviderInstant(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'string' || typeof value === 'number') {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
const E2B_STOP_TIMEOUT_MS = configuredTimeoutMs('KORTIX_E2B_STOP_TIMEOUT_MS', 25_000, 1_000);

/**
 * Every E2B SDK call this provider makes. `domain` is explicit and required:
 * the SDK defaults it to the E2B_DOMAIN process variable or `e2b.app`, while
 * Kortix's own config defaults E2B_DOMAIN to `e2b.dev`. Leaving it off pointed
 * sandbox creation at a DIFFERENT cluster than the one the snapshot adapter
 * built the template on whenever an operator did not export the variable —
 * which is exactly the self-hosted-E2B case, where the cluster is neither.
 */
function apiOpts() {
  return {
    apiKey: config.E2B_API_KEY,
    domain: e2bDomain(),
    requestTimeoutMs: 20_000,
  } as const;
}

function isMissingSandboxError(error: unknown): boolean {
  if (error instanceof SandboxNotFoundError) return true;
  const err = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  } | null;
  if (err?.status === 404 || err?.statusCode === 404 || err?.code === 404) return true;
  return /not found|does not exist|no such sandbox/i.test(String(err?.message ?? error ?? ''));
}

/**
 * Traffic tokens are returned on create/connect, not by getInfo. Keep the live
 * handle so normal proxy traffic avoids a control-plane round trip; reconnect
 * after API restarts recovers a fresh token and explicitly resumes a paused box.
 */
const connectedSandboxes = new Map<string, E2BSandbox>();
export const E2B_INGRESS_HANDLE_TTL_MS = 5_000;
const connectedSandboxCachedAt = new Map<string, number>();
const connectOperations = new Map<string, { generation: object; promise: Promise<E2BSandbox> }>();
export const E2B_RUNNING_STATUS_CACHE_TTL_MS = 3_000;
const runningStatusCache = new Map<string, number>();
const statusCacheGeneration = new Map<string, object>();
const startOperations = new Map<string, Promise<void>>();

function currentStatusGeneration(externalId: string): object {
  const existing = statusCacheGeneration.get(externalId);
  if (existing) return existing;
  const generation = {};
  statusCacheGeneration.set(externalId, generation);
  return generation;
}

function invalidateRunningStatus(externalId: string): void {
  runningStatusCache.delete(externalId);
  statusCacheGeneration.set(externalId, {});
}

function invalidateConnectedSandbox(externalId: string): void {
  connectedSandboxes.delete(externalId);
  connectedSandboxCachedAt.delete(externalId);
  connectOperations.delete(externalId);
}

function validateRuntimeEnv(value: unknown, externalId: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[e2b] sandbox ${externalId} has an invalid persisted runtime environment`);
  }
  const envs: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new Error(
        `[e2b] sandbox ${externalId} has a non-string persisted runtime environment value`,
      );
    }
    envs[key] = item;
  }
  const workloadType = envs.KORTIX_WORKLOAD_TYPE === 'app' ? 'app' : 'session';
  const required = workloadType === 'app' ? 'KORTIX_APPD_TOKEN' : 'KORTIX_TOKEN';
  if (!envs[required]) {
    throw new Error(`[e2b] sandbox ${externalId} persisted runtime environment has no ${required}`);
  }
  return envs;
}

/**
 * E2B is the only provider that has to park the session environment on the
 * GUEST's own disk. Daytona and Platinum hand it back from their control plane
 * on resume, so on those two the session credential and the project's runtime
 * secrets exist only in a live process — the same reason the daemon keeps the
 * agent's env on tmpfs (kortix-sandbox-agent-server/src/agent-env-file.ts).
 * Here the file has to survive the pause, and `chmod 600 root` is thin cover:
 * the sandbox user has NOPASSWD sudo (packages/shared/src/sandbox/dockerfile-layer.ts).
 * What differs from a live process env is DURABILITY — the plaintext outlived
 * every pause, resume and filesystem snapshot of the box.
 *
 * Sealing it costs nothing operationally because the guest never reads this
 * file: apps/api reads it back and hands the values to the entrypoint as
 * command `envs`. So the key can stay entirely server-side, and the sandbox
 * keeps resuming exactly as before. Keyed per sandbox so a blob lifted off one
 * box cannot be opened on another.
 */
function runtimeEnvKey(externalId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(config.API_KEY_SECRET, 'utf8'),
      Buffer.from(externalId, 'utf8'),
      Buffer.from(RUNTIME_ENV_ENVELOPE, 'utf8'),
      32,
    ),
  );
}

function sealRuntimeEnv(externalId: string, envs: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', runtimeEnvKey(externalId), iv, {
    authTagLength: RUNTIME_ENV_TAG_LENGTH,
  });
  const sealed = Buffer.concat([cipher.update(JSON.stringify(envs), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: RUNTIME_ENV_ENVELOPE,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    env: sealed.toString('base64url'),
  });
}

function isSealedRuntimeEnv(
  value: unknown,
): value is { v: string; iv: string; tag: string; env: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.v !== RUNTIME_ENV_ENVELOPE) return false;
  return (
    typeof envelope.iv === 'string' &&
    typeof envelope.tag === 'string' &&
    typeof envelope.env === 'string'
  );
}

/**
 * Sandboxes paused before the env was sealed hold a plain JSON map at this
 * path. They must keep resuming — a resume is the one moment a box has no other
 * copy of its own environment — so an unsealed map is read as-is and left
 * alone rather than rejected or rewritten on the resume hot path.
 */
function openRuntimeEnv(externalId: string, raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  if (!isSealedRuntimeEnv(parsed)) return parsed;
  const tag = Buffer.from(parsed.tag, 'base64url');
  if (tag.length !== RUNTIME_ENV_TAG_LENGTH) {
    throw new Error('sealed runtime environment has an unsupported auth tag length');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    runtimeEnvKey(externalId),
    Buffer.from(parsed.iv, 'base64url'),
    { authTagLength: RUNTIME_ENV_TAG_LENGTH },
  );
  decipher.setAuthTag(tag);
  const opened = Buffer.concat([
    decipher.update(Buffer.from(parsed.env, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(opened.toString('utf8'));
}

async function persistRuntimeEnv(sandbox: E2BSandbox, envs: Record<string, string>): Promise<void> {
  await sandbox.files.write(RUNTIME_ENV_PATH, sealRuntimeEnv(sandbox.sandboxId, envs), {
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
    return validateRuntimeEnv(openRuntimeEnv(sandbox.sandboxId, raw), sandbox.sandboxId);
  } catch (error) {
    throw new Error(
      `[e2b] cannot restore runtime environment for sandbox ${sandbox.sandboxId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requirePrivateTrafficToken(sandbox: E2BSandbox): string {
  if (!sandbox.trafficAccessToken) {
    throw new Error(`[e2b] sandbox ${sandbox.sandboxId} has no private traffic access token`);
  }
  return sandbox.trafficAccessToken;
}

async function ensureKortixEntrypoint(
  sandbox: E2BSandbox,
  envs?: Record<string, string>,
): Promise<void> {
  const processes = await sandbox.commands.list({ requestTimeoutMs: 10_000 });
  const alreadyRunning = processes.some((process) =>
    `${process.cmd} ${process.args.join(' ')}`.includes(KORTIX_ENTRYPOINT),
  );
  if (!alreadyRunning) {
    // The guest lock is the cross-process/cross-replica authority. Two API
    // replicas can both miss commands.list() during the first few milliseconds
    // of a cold boot; only one is allowed to own the long-lived daemon.
    await sandbox.commands.run(KORTIX_ENTRYPOINT_COMMAND, {
      background: true,
      user: 'root',
      ...(envs ? { envs } : {}),
      // E2B applies timeoutMs to the total lifetime of a background command;
      // its default is 60s and our former 20s value deterministically killed
      // the Kortix daemon after boot. Zero is the SDK's documented no-timeout
      // value. The sandbox lifecycle/reaper remains the authority that stops it.
      timeoutMs: 0,
    });
  }
  await sandbox.commands.run(KORTIX_HEALTH_WAIT, {
    user: 'root',
    ...(envs ? { envs } : {}),
    timeoutMs: 190_000,
  });
}

async function ensureAppEntrypoint(
  sandbox: E2BSandbox,
  envs: Record<string, string>,
): Promise<void> {
  const processes = await sandbox.commands.list({ requestTimeoutMs: 10_000 });
  const alreadyRunning = processes.some((process) =>
    `${process.cmd} ${process.args.join(' ')}`.includes(KORTIX_APPD),
  );
  if (!alreadyRunning) {
    await sandbox.commands.run(KORTIX_APPD_COMMAND, {
      background: true,
      user: 'root',
      envs,
      timeoutMs: 0,
    });
  }
  await sandbox.commands.run(KORTIX_APPD_HEALTH_WAIT, {
    user: 'root',
    envs,
    timeoutMs: 190_000,
  });
}

export class E2BProvider implements SandboxProvider {
  readonly name: ProviderName = 'e2b';
  readonly ingressCacheTtlMs = 0;

  constructor(
    private readonly removeTimeoutMs = E2B_REMOVE_TIMEOUT_MS,
    private readonly renewTimeoutMs = E2B_RENEW_TIMEOUT_MS,
    private readonly stopTimeoutMs = E2B_STOP_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
  ) {}

  readonly provisioning: ProvisioningTraits = {
    async: false,
    stages: [{ id: 'creating', progress: 50, message: 'Creating E2B sandbox...' }],
  };

  async getProvisioningStatus(): Promise<ProvisioningStatus | null> {
    return null;
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    const workloadType = sandboxWorkloadType(opts);
    const template = opts.snapshot ?? config.E2B_TEMPLATE;
    if (!template) {
      throw new Error(
        'E2B create() has no template: pass opts.snapshot or set E2B_TEMPLATE to a ready E2B template.',
      );
    }

    const sandboxApiBase = config.KORTIX_URL.replace(/\/+$/, '')
      .replace(/\/v1\/router$/, '')
      .replace(/\/v1$/, '');
    const envVars: Record<string, string> = {
      KORTIX_API_URL: `${sandboxApiBase}/v1`,
      KORTIX_FRONTEND_URL: sandboxFrontendBaseUrl(),
      ...(workloadType === 'app' ? { KORTIX_WORKLOAD_TYPE: workloadType } : {}),
      ...opts.envVars,
    };
    assertWorkloadCredential(this.name, opts, envVars);

    const sandbox = await Sandbox.create(template, {
      ...apiOpts(),
      envs: envVars,
      metadata: {
        [MANAGED_METADATA]: 'true',
        [ENV_METADATA]: config.INTERNAL_KORTIX_ENV,
        kortix_account_id: opts.accountId,
        kortix_created_by: opts.userId,
        ...(workloadType === 'app' ? { kortix_workload: workloadType } : {}),
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
    connectedSandboxCachedAt.set(sandbox.sandboxId, this.now());
    try {
      // E2B preserves the filesystem but not Sandbox.create(...envs) across a
      // keepMemory:false pause. Persist the complete per-session environment on
      // the private rootfs so a cold resume (including after an API restart)
      // can relaunch the authenticated daemon — sealed, because the guest never
      // needs to read it back (see persistRuntimeEnv). Never put these secrets
      // in E2B metadata or Kortix DB metadata.
      await persistRuntimeEnv(sandbox, envVars);
      if (workloadType === 'app') await ensureAppEntrypoint(sandbox, envVars);
      else await ensureKortixEntrypoint(sandbox, envVars);
    } catch (error) {
      invalidateConnectedSandbox(sandbox.sandboxId);
      await sandbox.kill({ requestTimeoutMs: 20_000 }).catch(() => false);
      throw new Error(
        `[e2b] failed to launch Kortix entrypoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const externalId = sandbox.sandboxId;
    runningStatusCache.set(externalId, Date.now());
    const ingressPort = workloadType === 'app' ? 8080 : 8000;
    return {
      externalId,
      baseUrl: `${sandboxApiBase}/v1/p/${externalId}/${ingressPort}`,
      metadata: {
        provisionedBy: opts.userId,
        e2bSandboxId: externalId,
        template,
        version: SANDBOX_VERSION,
        lifecycle: 'pause-filesystem-explicit-resume',
        workloadType,
      },
    };
  }

  private async startOnce(externalId: string, generation: object): Promise<void> {
    try {
      const sandbox = await this.connectFresh(externalId, generation);
      if (statusCacheGeneration.get(externalId) === generation) {
        connectedSandboxes.set(externalId, sandbox);
        connectedSandboxCachedAt.set(externalId, this.now());
      }
      // A filesystem-only pause cold-boots on connect. E2B normally runs the
      // template start command during that boot; this explicit check makes the
      // Kortix runtime invariant independent of provider startup behavior.
      const envVars = await loadRuntimeEnv(sandbox);
      if (envVars.KORTIX_WORKLOAD_TYPE === 'app') await ensureAppEntrypoint(sandbox, envVars);
      else await ensureKortixEntrypoint(sandbox, envVars);
      if (statusCacheGeneration.get(externalId) === generation) {
        runningStatusCache.set(externalId, Date.now());
        connectedSandboxCachedAt.set(externalId, this.now());
      }
    } catch (error) {
      invalidateConnectedSandbox(externalId);
      invalidateRunningStatus(externalId);
      throw error;
    }
  }

  /**
   * E2B's Template.build takes cpuCount and memoryMB and has no disk parameter
   * (e2b 2.37.0), so an App's disk_gb is provider-managed here and must not be
   * billed as if Kortix had allocated it.
   */
  readonly appMachineSupport: AppMachineSupport = { cpu: true, memoryGb: true, diskGb: false };

  /**
   * Relaunch kortix-appd if it died. This used to be a no-op on the reasoning
   * that E2B honors the image ENTRYPOINT — but the App build overrides the
   * template start command with `sleep infinity` (see snapshots/providers/e2b),
   * so nothing brings appd back on its own. AppHostingProvider.waitUntilReady
   * calls this on a readiness stall precisely to recover a dead supervisor, and
   * on E2B that recovery did nothing. ensureAppEntrypoint is idempotent: it
   * checks the process list, launches under a guest flock only if needed, then
   * health-checks.
   */
  async ensureAppRuntimeStarted(externalId: string): Promise<void> {
    const sandbox = await this.connected(externalId);
    const envVars = await loadRuntimeEnv(sandbox);
    if (envVars.KORTIX_WORKLOAD_TYPE !== 'app') return;
    await ensureAppEntrypoint(sandbox, envVars);
  }

  async start(externalId: string): Promise<void> {
    const inFlight = startOperations.get(externalId);
    if (inFlight) return inFlight;

    invalidateRunningStatus(externalId);
    const generation = currentStatusGeneration(externalId);
    const operation = this.startOnce(externalId, generation).finally(() => {
      if (startOperations.get(externalId) === operation) {
        startOperations.delete(externalId);
      }
    });
    startOperations.set(externalId, operation);
    return operation;
  }

  async renewLifecycle(externalId: string): Promise<void> {
    // E2B's timeout is an ABSOLUTE provider deadline. Guest activity does not
    // move it. Reset it through the static control-plane API so this operation
    // cannot connect to, resume, or otherwise wake a stopped sandbox.
    const requestedAtMs = Date.now();
    await withTimeout(
      Sandbox.setTimeout(externalId, E2B_RUNTIME_BACKSTOP_MS, apiOpts()),
      this.renewTimeoutMs,
      `E2B lifecycle renewal(${externalId})`,
    );
    // A 204 is not proof. E2B's KeepAliveFor clamps every renewal to the
    // team's `max_length_hours` (tier + project_limits), so on a team capped
    // at 1h the deadline never moves past `startedAt + 1h` and the sandbox is
    // paused mid-turn exactly one hour after create/resume — while Kortix
    // logged a successful renewal every 20 s (Essentia 2026-08-25: 375 blind
    // 204s, 4 turns killed). Read the deadline back and refuse to call a
    // renewal that did not land a renewal.
    const info = await withTimeout(
      Sandbox.getInfo(externalId, apiOpts()),
      this.renewTimeoutMs,
      `E2B lifecycle renewal read-back(${externalId})`,
    );
    const endAtMs = parseProviderInstant(info.endAt);
    if (endAtMs === null) return;
    const expectedMinMs = requestedAtMs + E2B_RUNTIME_BACKSTOP_MS - E2B_RENEWAL_TOLERANCE_MS;
    if (endAtMs >= expectedMinMs) return;
    const shortfallS = Math.round((requestedAtMs + E2B_RUNTIME_BACKSTOP_MS - endAtMs) / 1000);
    const backstopS = Math.round(E2B_RUNTIME_BACKSTOP_MS / 1000);
    const message = `E2B ignored the lifecycle renewal for ${externalId}: provider endAt ${new Date(endAtMs).toISOString()} is ${shortfallS}s short of the requested ${backstopS}s backstop. The E2B team's max_length_hours caps every renewal; raise it (tiers.max_length_hours / project_limits) or this sandbox is paused mid-turn at endAt.`;
    console.error(`[e2b] ${message}`);
    throw new E2BLifecycleRenewalIgnoredError(message, endAtMs);
  }

  async stop(externalId: string): Promise<void> {
    invalidateRunningStatus(externalId);
    const sandbox = connectedSandboxes.get(externalId);
    await withTimeout(
      sandbox
        ? sandbox.pause({ ...apiOpts(), keepMemory: false })
        : Sandbox.pause(externalId, { ...apiOpts(), keepMemory: false }),
      this.stopTimeoutMs,
      `E2B stop(${externalId})`,
    );
    invalidateRunningStatus(externalId);
    invalidateConnectedSandbox(externalId);
  }

  async remove(externalId: string): Promise<void> {
    invalidateConnectedSandbox(externalId);
    invalidateRunningStatus(externalId);
    try {
      await withTimeout(
        Sandbox.kill(externalId, apiOpts()),
        this.removeTimeoutMs,
        `E2B kill(${externalId})`,
      );
    } catch (error) {
      if (!isMissingSandboxError(error)) throw error;
    } finally {
      invalidateRunningStatus(externalId);
      statusCacheGeneration.delete(externalId);
    }
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    const cachedAt = runningStatusCache.get(externalId);
    if (cachedAt !== undefined && Date.now() - cachedAt < E2B_RUNNING_STATUS_CACHE_TTL_MS)
      return 'running';
    const generation = currentStatusGeneration(externalId);
    try {
      const info = await Sandbox.getInfo(externalId, apiOpts());
      if (info.state === 'running') {
        if (statusCacheGeneration.get(externalId) === generation) {
          runningStatusCache.set(externalId, Date.now());
        }
        return 'running';
      }
      invalidateRunningStatus(externalId);
      if (info.state === 'paused') return 'stopped';
      return 'unknown';
    } catch (error) {
      invalidateRunningStatus(externalId);
      if (isMissingSandboxError(error)) {
        statusCacheGeneration.delete(externalId);
        return 'removed';
      }
      return 'unknown';
    }
  }

  private async connected(externalId: string): Promise<E2BSandbox> {
    const cached = connectedSandboxes.get(externalId);
    const cachedAt = connectedSandboxCachedAt.get(externalId);
    if (cached && cachedAt !== undefined && this.now() - cachedAt < E2B_INGRESS_HANDLE_TTL_MS)
      return cached;

    const providerStatus = await this.getStatus(externalId);
    if (providerStatus !== 'running') {
      throw new Error(`[e2b] sandbox ${externalId} is not running (status: ${providerStatus})`);
    }
    const generation = currentStatusGeneration(externalId);
    return this.connectFresh(externalId, generation);
  }

  private connectFresh(externalId: string, generation: object): Promise<E2BSandbox> {
    const inFlight = connectOperations.get(externalId);
    if (inFlight) return inFlight.promise;

    const promise = Sandbox.connect(externalId, {
      ...apiOpts(),
      timeoutMs: E2B_RUNTIME_BACKSTOP_MS,
    })
      .then((sandbox) => {
        if (statusCacheGeneration.get(externalId) === generation) {
          connectedSandboxes.set(externalId, sandbox);
          connectedSandboxCachedAt.set(externalId, this.now());
        }
        return sandbox;
      })
      .finally(() => {
        if (connectOperations.get(externalId)?.promise === promise) {
          connectOperations.delete(externalId);
        }
      });
    connectOperations.set(externalId, { generation, promise });
    return promise;
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
    const headers: Record<string, string> = {
      ...ingress.headers,
      'Content-Type': 'application/json',
    };
    const serviceKey = await serviceKeyForExternalId(externalId).catch(() => null);
    if (serviceKey) headers.Authorization = `Bearer ${serviceKey}`;
    return { url: ingress.url, headers };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const status = await this.getStatus(externalId);
    if (status === 'running') return;
    if (status === 'stopped') await this.start(externalId);
  }

  async listManagedRunningSandboxes(): Promise<
    Array<{ externalId: string; createdAt: Date | null }>
  > {
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
