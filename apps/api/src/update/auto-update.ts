import { eq } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { config } from '../config';
import { getProvider, type ProviderName } from '../platform/providers';
import { LocalDockerProvider, getSandboxUpdateStatus } from '../platform/providers/local-docker';
import { executeUpdate } from './executor';
import { getUpdateStatus } from './status';
import { getLatestVersionForChannel, hasNewerSandboxVersion, type VersionChannel } from '../platform/routes/version';

export interface SandboxAutoUpdatePolicy {
  enabled: boolean;
  channel: VersionChannel;
  lastCheckedAt: string | null;
  lastCheckedVersion: string | null;
  lastAttemptedAt: string | null;
  lastAttemptedVersion: string | null;
  lastCompletedAt: string | null;
  lastCompletedVersion: string | null;
  lastError: string | null;
  lastDecision: 'up_to_date' | 'triggered' | 'cooldown' | 'disabled' | 'unsupported' | 'failed' | 'missing_version' | null;
}

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_RETRY_COOLDOWN_MS = 6 * 60 * 60_000;
const ACTIVE_PHASES = new Set(['pulling', 'patching', 'backing_up', 'stopping', 'removing', 'recreating', 'restarting', 'verifying', 'starting', 'health_check', 'preflight']);
const AUTO_UPDATE_PROVIDERS = new Set<ProviderName>(['justavps', 'local_docker']);

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

function detectChannel(version: string | null | undefined): VersionChannel {
  return version?.startsWith('dev-') ? 'dev' : 'stable';
}

export function defaultSandboxAutoUpdatePolicy(version?: string | null): SandboxAutoUpdatePolicy {
  return {
    enabled: true,
    channel: detectChannel(version ?? null),
    lastCheckedAt: null,
    lastCheckedVersion: null,
    lastAttemptedAt: null,
    lastAttemptedVersion: null,
    lastCompletedAt: null,
    lastCompletedVersion: null,
    lastError: null,
    lastDecision: null,
  };
}

export function getSandboxAutoUpdatePolicy(metadata: Record<string, unknown> | null | undefined, version?: string | null): SandboxAutoUpdatePolicy {
  const defaults = defaultSandboxAutoUpdatePolicy(version ?? null);
  const raw = (metadata?.autoUpdate ?? {}) as Partial<SandboxAutoUpdatePolicy>;
  const channel = raw.channel === 'dev' || raw.channel === 'stable' ? raw.channel : defaults.channel;
  return {
    ...defaults,
    ...raw,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    channel,
  };
}

async function updatePolicy(sandboxId: string, metadata: Record<string, unknown> | null | undefined, patch: Partial<SandboxAutoUpdatePolicy>) {
  const next = {
    ...(metadata ?? {}),
    autoUpdate: {
      ...getSandboxAutoUpdatePolicy(metadata),
      ...patch,
    },
  };
  await db.update(sandboxes).set({ metadata: next, updatedAt: new Date() }).where(eq(sandboxes.sandboxId, sandboxId));
}

function getCurrentVersion(row: typeof sandboxes.$inferSelect) {
  const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
  const version = metadata.version;
  if (typeof version === 'string' && version.trim()) return version.trim();
  if (row.provider === 'local_docker') return process.env.SANDBOX_VERSION || 'unknown';
  return null;
}

function shouldRetry(policy: SandboxAutoUpdatePolicy, targetVersion: string, now: number) {
  if (!policy.lastAttemptedAt || policy.lastAttemptedVersion !== targetVersion) return true;
  const attemptedAt = Date.parse(policy.lastAttemptedAt);
  if (Number.isNaN(attemptedAt)) return true;
  return now - attemptedAt >= (config.SANDBOX_AUTO_UPDATE_RETRY_COOLDOWN_MS || DEFAULT_RETRY_COOLDOWN_MS);
}

async function getCurrentUpdatePhase(row: typeof sandboxes.$inferSelect) {
  if (row.provider === 'local_docker') {
    return getSandboxUpdateStatus().phase;
  }
  return (await getUpdateStatus(row.sandboxId)).phase;
}

async function triggerAutoUpdate(row: typeof sandboxes.$inferSelect, targetVersion: string, currentVersion: string, latestVersion: string, policy: SandboxAutoUpdatePolicy) {
  const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
  await updatePolicy(row.sandboxId, metadata, {
    ...policy,
    lastCheckedAt: new Date().toISOString(),
    lastCheckedVersion: latestVersion,
    lastAttemptedAt: new Date().toISOString(),
    lastAttemptedVersion: targetVersion,
    lastDecision: 'triggered',
    lastError: null,
  });

  if (row.provider === 'local_docker') {
    const provider = getProvider('local_docker');
    if (!(provider instanceof LocalDockerProvider)) throw new Error('local_docker provider unavailable');
    await provider.updateSandbox(targetVersion);
  } else {
    await executeUpdate(row.sandboxId, targetVersion);
  }

  await updatePolicy(row.sandboxId, metadata, {
    ...policy,
    channel: policy.channel,
    lastCheckedAt: new Date().toISOString(),
    lastCheckedVersion: latestVersion,
    lastCompletedAt: new Date().toISOString(),
    lastCompletedVersion: targetVersion,
    lastDecision: 'up_to_date',
    lastError: null,
  });

  console.log(`[sandbox-auto-update] Updated ${row.sandboxId} from ${currentVersion} to ${targetVersion}`);
}

async function scanOnce() {
  if (running || !config.SANDBOX_AUTO_UPDATE_ENABLED) return;
  running = true;

  try {
    const rows = (await db.select().from(sandboxes)).filter((row) =>
      (row.status === 'active' || row.status === 'stopped')
      && (row.provider === 'justavps' || row.provider === 'local_docker'),
    );

    for (const row of rows) {
      if (!AUTO_UPDATE_PROVIDERS.has(row.provider as ProviderName)) continue;

      const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
      const currentVersion = getCurrentVersion(row);
      const policy = getSandboxAutoUpdatePolicy(metadata, currentVersion);

      if (!policy.enabled) {
        await updatePolicy(row.sandboxId, metadata, { ...policy, lastDecision: 'disabled', lastCheckedAt: new Date().toISOString() });
        continue;
      }

      if (!currentVersion) {
        await updatePolicy(row.sandboxId, metadata, { ...policy, lastDecision: 'missing_version', lastCheckedAt: new Date().toISOString(), lastError: 'Missing current sandbox version' });
        continue;
      }

      const phase = await getCurrentUpdatePhase(row);
      if (ACTIVE_PHASES.has(phase)) continue;

      const latest = await getLatestVersionForChannel(policy.channel);
      const now = Date.now();
      const latestVersion = latest.version;
      const newer = hasNewerSandboxVersion(currentVersion, latestVersion, policy.channel);

      if (!newer) {
        await updatePolicy(row.sandboxId, metadata, {
          ...policy,
          lastCheckedAt: new Date(now).toISOString(),
          lastCheckedVersion: latestVersion,
          lastCompletedVersion: currentVersion,
          lastDecision: 'up_to_date',
          lastError: null,
        });
        continue;
      }

      if (!shouldRetry(policy, latestVersion, now)) {
        await updatePolicy(row.sandboxId, metadata, {
          ...policy,
          lastCheckedAt: new Date(now).toISOString(),
          lastCheckedVersion: latestVersion,
          lastDecision: 'cooldown',
        });
        continue;
      }

      try {
        await triggerAutoUpdate(row, latestVersion, currentVersion, latestVersion, policy);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await updatePolicy(row.sandboxId, metadata, {
          ...policy,
          lastCheckedAt: new Date().toISOString(),
          lastCheckedVersion: latestVersion,
          lastAttemptedAt: new Date().toISOString(),
          lastAttemptedVersion: latestVersion,
          lastDecision: 'failed',
          lastError: message,
        });
        console.error(`[sandbox-auto-update] Failed for ${row.sandboxId}:`, message);
      }

      break;
    }
  } finally {
    running = false;
  }
}

export function startSandboxAutoUpdateLoop() {
  if (interval || !config.SANDBOX_AUTO_UPDATE_ENABLED || !config.DATABASE_URL) return;
  const ms = config.SANDBOX_AUTO_UPDATE_INTERVAL_MS || DEFAULT_INTERVAL_MS;
  setTimeout(() => {
    void scanOnce();
    interval = setInterval(() => { void scanOnce(); }, ms);
  }, 10_000);
  console.log(`[sandbox-auto-update] Started (interval: ${Math.round(ms / 1000)}s, enabled by default)`);
}

export function stopSandboxAutoUpdateLoop() {
  if (!interval) return;
  clearInterval(interval);
  interval = null;
}
