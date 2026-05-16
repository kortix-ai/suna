import { and, desc, eq } from 'drizzle-orm';
import { projectConnectors } from '@kortix/db';
import { db } from '../shared/db';

export type ProjectConnectorRow = typeof projectConnectors.$inferSelect;
export type ProjectConnectorStatus = 'active' | 'revoked' | 'expired' | 'error';

export function serializeProjectConnector(
  row: ProjectConnectorRow,
  options: { includeProviderAccountId?: boolean } = {},
) {
  return {
    connector_id: row.connectorId,
    account_id: row.accountId,
    project_id: row.projectId,
    provider: row.providerName,
    app: row.app,
    app_name: row.appName,
    label: row.label,
    status: row.status,
    scopes: row.scopes ?? [],
    metadata: row.metadata ?? {},
    connected_at: row.connectedAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    ...(options.includeProviderAccountId ? { provider_account_id: row.providerAccountId } : {}),
  };
}

export function parseProjectConnectorStatus(value: unknown): ProjectConnectorStatus | null {
  if (value === 'active' || value === 'revoked' || value === 'expired' || value === 'error') {
    return value;
  }
  return null;
}

export async function listProjectConnectors(accountId: string, projectId: string) {
  return db
    .select()
    .from(projectConnectors)
    .where(and(
      eq(projectConnectors.accountId, accountId),
      eq(projectConnectors.projectId, projectId),
    ))
    .orderBy(desc(projectConnectors.updatedAt));
}

export async function listActiveProjectConnectors(accountId: string, projectId: string) {
  return db
    .select()
    .from(projectConnectors)
    .where(and(
      eq(projectConnectors.accountId, accountId),
      eq(projectConnectors.projectId, projectId),
      eq(projectConnectors.status, 'active'),
    ))
    .orderBy(desc(projectConnectors.updatedAt));
}

export async function getProjectConnector(input: {
  accountId: string;
  projectId: string;
  connectorId: string;
}) {
  const [row] = await db
    .select()
    .from(projectConnectors)
    .where(and(
      eq(projectConnectors.accountId, input.accountId),
      eq(projectConnectors.projectId, input.projectId),
      eq(projectConnectors.connectorId, input.connectorId),
    ))
    .limit(1);
  return row ?? null;
}

export async function findActiveProjectConnector(input: {
  accountId: string;
  projectId: string;
  connectorId?: string | null;
  app?: string | null;
}) {
  if (input.connectorId) {
    const row = await getProjectConnector({
      accountId: input.accountId,
      projectId: input.projectId,
      connectorId: input.connectorId,
    });
    return row?.status === 'active' ? row : null;
  }

  if (!input.app) return null;
  const [row] = await db
    .select()
    .from(projectConnectors)
    .where(and(
      eq(projectConnectors.accountId, input.accountId),
      eq(projectConnectors.projectId, input.projectId),
      eq(projectConnectors.app, input.app),
      eq(projectConnectors.status, 'active'),
    ))
    .orderBy(desc(projectConnectors.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function upsertProjectConnector(input: {
  accountId: string;
  projectId: string;
  providerName?: string;
  app: string;
  appName?: string | null;
  providerAccountId: string;
  label?: string | null;
  scopes?: string[];
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
}) {
  const now = new Date();
  const providerName = input.providerName ?? 'pipedream';
  const [row] = await db
    .insert(projectConnectors)
    .values({
      accountId: input.accountId,
      projectId: input.projectId,
      providerName,
      app: input.app,
      appName: input.appName ?? null,
      providerAccountId: input.providerAccountId,
      label: input.label ?? null,
      status: 'active',
      scopes: input.scopes ?? [],
      metadata: input.metadata ?? {},
      createdBy: input.createdBy ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projectConnectors.projectId, projectConnectors.providerName, projectConnectors.providerAccountId],
      set: {
        app: input.app,
        appName: input.appName ?? null,
        label: input.label ?? null,
        status: 'active',
        scopes: input.scopes ?? [],
        metadata: input.metadata ?? {},
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

export async function touchProjectConnectorLastUsed(connectorId: string) {
  await db
    .update(projectConnectors)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(projectConnectors.connectorId, connectorId));
}
