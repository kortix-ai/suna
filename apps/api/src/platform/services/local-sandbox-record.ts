import { sandboxes, type Database } from '@kortix/db';
import { config } from '../../config';

type SandboxRow = typeof sandboxes.$inferSelect;
type LocalSandboxRecord = Pick<
  SandboxRow,
  | 'sandboxId'
  | 'externalId'
  | 'name'
  | 'provider'
  | 'baseUrl'
  | 'status'
  | 'metadata'
  | 'createdAt'
  | 'updatedAt'
  | 'isIncluded'
  | 'stripeSubscriptionItemId'
>;

function getMappedPorts(): Record<string, string> {
  const base = config.SANDBOX_PORT_BASE || 14000;
  return {
    '8000': String(base + 0),
    '3111': String(base + 1),
    '6080': String(base + 2),
    '6081': String(base + 3),
    '3210': String(base + 4),
    '9223': String(base + 5),
    '9224': String(base + 6),
    '22': String(base + 7),
  };
}

function getHealthUrl(): string {
  return config.SANDBOX_NETWORK
    ? `http://${config.SANDBOX_CONTAINER_NAME}:8000/kortix/health`
    : `http://localhost:${config.SANDBOX_PORT_BASE || 14000}/kortix/health`;
}

function getBaseUrl(): string {
  return `http://localhost:${config.PORT || 8008}/v1/p/${config.SANDBOX_CONTAINER_NAME}/8000`;
}

export function serializeLocalSandbox(row: LocalSandboxRecord) {
  const metadata = row.metadata as Record<string, unknown> | null;
  return {
    sandbox_id: row.sandboxId,
    external_id: row.externalId,
    name: row.name,
    provider: row.provider,
    base_url: row.baseUrl,
    status: row.status,
    version: metadata?.version ?? null,
    metadata: row.metadata,
    is_included: Boolean(row.isIncluded ?? false),
    stripe_subscription_id: null,
    stripe_subscription_item_id: row.stripeSubscriptionItemId ?? null,
    cancel_at_period_end: false,
    cancel_at: null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function syntheticLocalSandbox(snapshot: {
  baseUrl: string;
  externalId: string;
  metadata: Record<string, unknown>;
}): LocalSandboxRecord {
  const now = new Date();
  return {
    // This bridge route is unauthenticated and only describes the local runtime.
    // Do not leak or reuse an arbitrary DB uuid from a shared/remote database.
    sandboxId: config.SANDBOX_CONTAINER_NAME,
    externalId: snapshot.externalId,
    name: 'Local Sandbox',
    provider: 'local_docker',
    status: 'active',
    baseUrl: snapshot.baseUrl,
    metadata: snapshot.metadata,
    createdAt: now,
    updatedAt: now,
    isIncluded: false,
    stripeSubscriptionItemId: null,
  };
}

async function getLocalSandboxSnapshot(): Promise<{
  baseUrl: string;
  externalId: string;
  metadata: Record<string, unknown>;
} | null> {
  try {
    const health = await fetch(getHealthUrl(), { signal: AbortSignal.timeout(3000) });
    if (!health.ok) return null;

    const payload = await health.json() as { status?: string; runtimeReady?: boolean; version?: string };
    if (payload.status !== 'ok' || payload.runtimeReady !== true) return null;

    return {
      baseUrl: getBaseUrl(),
      externalId: config.SANDBOX_CONTAINER_NAME,
      metadata: {
        mappedPorts: getMappedPorts(),
        version: payload.version || null,
        localSandbox: true,
      },
    };
  } catch {
    return null;
  }
}

export async function ensureGenericLocalSandboxRecord(_db: Database): Promise<LocalSandboxRecord | null> {
  const snapshot = await getLocalSandboxSnapshot();
  if (!snapshot) return null;

  // Read-only discovery: never create/update DB rows from the unauthenticated
  // bridge. Authenticated users can explicitly adopt a manually-running local
  // sandbox via POST /platform/init/local.
  return syntheticLocalSandbox(snapshot);
}
