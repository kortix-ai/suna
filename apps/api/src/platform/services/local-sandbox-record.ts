import { and, desc, eq, ne } from 'drizzle-orm';
import { accounts, sandboxes, type Database } from '@kortix/db';
import { config } from '../../config';

type SandboxRow = typeof sandboxes.$inferSelect;

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
  const routerBase = (config.KORTIX_URL || `http://localhost:${config.PORT || 8008}/v1/router`).replace(/\/router$/, '');
  return `${routerBase}/p/${config.SANDBOX_CONTAINER_NAME}/8000`;
}

export function serializeLocalSandbox(row: SandboxRow) {
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

async function findExistingLocalSandboxRow(db: Database): Promise<SandboxRow | null> {
  const [row] = await db
    .select()
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.provider, 'local_docker'),
        eq(sandboxes.externalId, config.SANDBOX_CONTAINER_NAME),
        ne(sandboxes.status, 'archived'),
      ),
    )
    .orderBy(desc(sandboxes.updatedAt), desc(sandboxes.createdAt))
    .limit(1);

  return row ?? null;
}

export async function ensureGenericLocalSandboxRecord(db: Database): Promise<SandboxRow | null> {
  const snapshot = await getLocalSandboxSnapshot();
  if (!snapshot) return null;

  const existing = await findExistingLocalSandboxRow(db);

  if (existing) {
    const [updated] = await db
      .update(sandboxes)
      .set({
        name: 'Local Sandbox',
        provider: 'local_docker',
        externalId: snapshot.externalId,
        status: 'active',
        baseUrl: snapshot.baseUrl,
        metadata: {
          ...(existing.metadata as Record<string, unknown> | null ?? {}),
          ...snapshot.metadata,
        },
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.sandboxId, existing.sandboxId))
      .returning();

    return updated ?? existing;
  }

  const [account] = await db.select().from(accounts).limit(1);
  if (!account) return null;

  const [created] = await db
    .insert(sandboxes)
    .values({
      accountId: account.accountId,
      name: 'Local Sandbox',
      provider: 'local_docker',
      externalId: snapshot.externalId,
      status: 'active',
      baseUrl: snapshot.baseUrl,
      config: {},
      metadata: snapshot.metadata,
    })
    .returning();

  return created ?? null;
}
