import { createHash, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import {
  agentKnowledgeAssignments,
  agentKnowledgeSources,
  agentKnowledgeSyncJobs,
  agentKnowledgeVersions,
  executorConnectionProfiles,
  executorConnectorActions,
  executorConnectors,
} from '@kortix/db';
import { SLUG_RE } from '@kortix/manifest-schema';
import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../../shared/db';
import { getSupabase } from '../../shared/supabase';

export const AGENT_KNOWLEDGE_BUCKET = 'agent-knowledge';
export const AGENT_KNOWLEDGE_MAX_FILE_SIZE = 50 * 1024 * 1024;
export const AGENT_KNOWLEDGE_UPLOAD_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
]);

const SOURCE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export type AgentKnowledgeSourceRecord = typeof agentKnowledgeSources.$inferSelect & {
  activeVersion: typeof agentKnowledgeVersions.$inferSelect | null;
};

export interface CreateAgentKnowledgeSourceInput {
  type: 'url' | 'connector';
  title: string;
  url?: string;
  connectorProfileId?: string;
  resourceId?: string;
  connectorAction?: string;
  resourceArgument?: string;
  automaticSync?: boolean;
}

export class AgentKnowledgeInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentKnowledgeInputError';
  }
}

function assertAgentName(agentName: string): void {
  if (!SLUG_RE.test(agentName)) {
    throw new AgentKnowledgeInputError('invalid_agent_name', 'Agent name is invalid.');
  }
}

function sourceSlug(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
  const safeBase = SLUG_RE.test(base) ? base : 'knowledge-source';
  return `${safeBase}-${crypto.randomUUID().slice(0, 8)}`;
}

function validateTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized || normalized.length > 500) {
    throw new AgentKnowledgeInputError(
      'invalid_title',
      'Knowledge source title must contain 1 to 500 characters.',
    );
  }
  return normalized;
}

function validateSourceUrl(value: string | undefined): string {
  if (!value) throw new AgentKnowledgeInputError('invalid_url', 'A source URL is required.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentKnowledgeInputError('invalid_url', 'Source URL must be a valid HTTP URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AgentKnowledgeInputError('invalid_url', 'Source URL must use HTTP or HTTPS.');
  }
  url.hash = '';
  return url.toString();
}

async function assertConnectorProfile(input: {
  accountId: string;
  projectId: string;
  profileId: string | undefined;
  resourceId: string | undefined;
  connectorAction: string | undefined;
  resourceArgument: string | undefined;
}): Promise<{
  profileId: string;
  resourceId: string;
  sourceConfig: { connectorSlug: string; readAction: string; resourceArgument: string };
}> {
  if (!input.profileId || !input.resourceId?.trim()) {
    throw new AgentKnowledgeInputError(
      'invalid_connector_resource',
      'A connected app profile and selected resource are required.',
    );
  }
  const [profile] = await db
    .select({
      profileId: executorConnectionProfiles.profileId,
      connectorId: executorConnectionProfiles.connectorId,
      connectorSlug: executorConnectors.slug,
    })
    .from(executorConnectionProfiles)
    .innerJoin(
      executorConnectors,
      eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
    )
    .where(
      and(
        eq(executorConnectionProfiles.profileId, input.profileId),
        eq(executorConnectionProfiles.accountId, input.accountId),
        eq(executorConnectionProfiles.projectId, input.projectId),
        eq(executorConnectionProfiles.status, 'active'),
        eq(executorConnectors.accountId, input.accountId),
        eq(executorConnectors.projectId, input.projectId),
        eq(executorConnectors.status, 'active'),
      ),
    )
    .limit(1);
  if (!profile) {
    throw new AgentKnowledgeInputError(
      'connector_profile_not_found',
      'The selected connected app profile is not available in this project.',
    );
  }

  const actions = await db
    .select({
      path: executorConnectorActions.path,
      risk: executorConnectorActions.risk,
      inputSchema: executorConnectorActions.inputSchema,
    })
    .from(executorConnectorActions)
    .where(eq(executorConnectorActions.connectorId, profile.connectorId));
  const selectedAction = input.connectorAction
    ? actions.find((action) => action.path === input.connectorAction)
    : actions
        .filter((action) => action.risk === 'read')
        .sort((left, right) => {
          const score = (path: string) =>
            /(^|[._/-])(get|read|download|fetch|retrieve|export)([._/-]|$)/i.test(path) ? 0 : 1;
          return score(left.path) - score(right.path) || left.path.localeCompare(right.path);
        })[0];
  if (!selectedAction) {
    throw new AgentKnowledgeInputError(
      'connector_read_action_not_found',
      'The selected connected app does not expose a resource read action.',
    );
  }
  if (selectedAction.risk !== 'read') {
    throw new AgentKnowledgeInputError(
      'connector_action_not_read_only',
      'Knowledge synchronization can use read-only connected app actions only.',
    );
  }

  const properties =
    selectedAction.inputSchema &&
    typeof selectedAction.inputSchema.properties === 'object' &&
    selectedAction.inputSchema.properties !== null
      ? (selectedAction.inputSchema.properties as Record<string, unknown>)
      : {};
  const preferredArguments = [
    'resource_id',
    'file_id',
    'document_id',
    'page_id',
    'record_id',
    'id',
    'url',
  ];
  const resourceArgument = input.resourceArgument ?? preferredArguments.find((key) => key in properties);
  if (!resourceArgument || !(resourceArgument in properties)) {
    throw new AgentKnowledgeInputError(
      'connector_resource_argument_not_found',
      'The selected connected app action does not accept the selected resource identifier.',
    );
  }

  return {
    profileId: profile.profileId,
    resourceId: input.resourceId.trim(),
    sourceConfig: {
      connectorSlug: profile.connectorSlug,
      readAction: selectedAction.path,
      resourceArgument,
    },
  };
}

export async function listAgentKnowledgeSourceRecords(
  projectId: string,
  agentName: string,
): Promise<AgentKnowledgeSourceRecord[]> {
  assertAgentName(agentName);
  const rows = await db
    .select({ source: agentKnowledgeSources, version: agentKnowledgeVersions })
    .from(agentKnowledgeSources)
    .leftJoin(
      agentKnowledgeVersions,
      eq(agentKnowledgeVersions.versionId, agentKnowledgeSources.activeVersionId),
    )
    .where(
      and(
        eq(agentKnowledgeSources.projectId, projectId),
        eq(agentKnowledgeSources.agentName, agentName),
        ne(agentKnowledgeSources.status, 'revoked'),
      ),
    )
    .orderBy(desc(agentKnowledgeSources.updatedAt));
  return rows.map(({ source, version }) => ({ ...source, activeVersion: version ?? null }));
}

export async function getAgentKnowledgeSourceRecord(
  projectId: string,
  agentName: string,
  sourceId: string,
  includeRevoked = false,
): Promise<AgentKnowledgeSourceRecord | null> {
  assertAgentName(agentName);
  const filters = [
    eq(agentKnowledgeSources.projectId, projectId),
    eq(agentKnowledgeSources.agentName, agentName),
    eq(agentKnowledgeSources.sourceId, sourceId),
  ];
  if (!includeRevoked) filters.push(ne(agentKnowledgeSources.status, 'revoked'));
  const [row] = await db
    .select({ source: agentKnowledgeSources, version: agentKnowledgeVersions })
    .from(agentKnowledgeSources)
    .leftJoin(
      agentKnowledgeVersions,
      eq(agentKnowledgeVersions.versionId, agentKnowledgeSources.activeVersionId),
    )
    .where(and(...filters))
    .limit(1);
  return row ? { ...row.source, activeVersion: row.version ?? null } : null;
}

export async function createAgentKnowledgeSourceRecord(input: {
  accountId: string;
  projectId: string;
  agentName: string;
  userId: string;
  input: CreateAgentKnowledgeSourceInput;
}): Promise<AgentKnowledgeSourceRecord> {
  assertAgentName(input.agentName);
  const title = validateTitle(input.input.title);
  const automaticSync = input.input.automaticSync ?? true;
  const now = new Date();
  let url: string | null = null;
  let connectorProfileId: string | null = null;
  let resourceId: string | null = null;
  let sourceConfig: Record<string, unknown> = {};
  if (input.input.type === 'url') {
    url = validateSourceUrl(input.input.url);
  } else {
    const connector = await assertConnectorProfile({
      accountId: input.accountId,
      projectId: input.projectId,
      profileId: input.input.connectorProfileId,
      resourceId: input.input.resourceId,
      connectorAction: input.input.connectorAction,
      resourceArgument: input.input.resourceArgument,
    });
    connectorProfileId = connector.profileId;
    resourceId = connector.resourceId;
    sourceConfig = connector.sourceConfig;
  }

  const [source] = await db
    .insert(agentKnowledgeSources)
    .values({
      accountId: input.accountId,
      projectId: input.projectId,
      agentName: input.agentName,
      slug: sourceSlug(title),
      sourceType: input.input.type,
      title,
      status: 'pending',
      url,
      connectorProfileId,
      resourceId,
      sourceConfig,
      automaticSync,
      syncIntervalHours: automaticSync ? 24 : null,
      nextSyncAt: now,
      createdBy: input.userId,
      expiresAt: new Date(now.getTime() + SOURCE_EXPIRY_MS),
    })
    .returning();
  if (!source) throw new Error('Failed to create knowledge source.');
  await enqueueAgentKnowledgeSync(input.projectId, input.agentName, source.sourceId);
  return { ...source, activeVersion: null };
}

export async function enqueueAgentKnowledgeSync(
  projectId: string,
  agentName: string,
  sourceId: string,
): Promise<boolean> {
  const source = await getAgentKnowledgeSourceRecord(projectId, agentName, sourceId);
  if (!source) return false;
  await db
    .insert(agentKnowledgeSyncJobs)
    .values({
      accountId: source.accountId,
      projectId,
      agentName,
      sourceId,
      status: 'pending',
      availableAt: new Date(),
    })
    .onConflictDoNothing();
  await db
    .update(agentKnowledgeSources)
    .set({ status: 'pending', lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(agentKnowledgeSources.projectId, projectId),
        eq(agentKnowledgeSources.agentName, agentName),
        eq(agentKnowledgeSources.sourceId, sourceId),
        ne(agentKnowledgeSources.status, 'revoked'),
      ),
    );
  return true;
}

export async function revokeAgentKnowledgeSourceRecord(
  projectId: string,
  agentName: string,
  sourceId: string,
  userId: string,
): Promise<boolean> {
  assertAgentName(agentName);
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(agentKnowledgeSources)
      .set({
        status: 'revoked',
        revokedAt: now,
        revokedBy: userId,
        nextSyncAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentKnowledgeSources.projectId, projectId),
          eq(agentKnowledgeSources.agentName, agentName),
          eq(agentKnowledgeSources.sourceId, sourceId),
          ne(agentKnowledgeSources.status, 'revoked'),
        ),
      )
      .returning({ storagePath: agentKnowledgeSources.storagePath });
    if (!revoked) return null;

    await tx
      .update(agentKnowledgeAssignments)
      .set({ active: false, updatedAt: now })
      .where(
        and(
          eq(agentKnowledgeAssignments.projectId, projectId),
          eq(agentKnowledgeAssignments.agentName, agentName),
          eq(agentKnowledgeAssignments.sourceId, sourceId),
        ),
      );
    await tx
      .update(agentKnowledgeSyncJobs)
      .set({
        status: 'dead_lettered',
        leaseOwner: null,
        leaseUntil: null,
        completedAt: now,
        lastError: 'Source revoked',
        updatedAt: now,
      })
      .where(
        and(
          eq(agentKnowledgeSyncJobs.projectId, projectId),
          eq(agentKnowledgeSyncJobs.agentName, agentName),
          eq(agentKnowledgeSyncJobs.sourceId, sourceId),
        ),
      );
    return revoked;
  });

  if (!result) return false;
  if (result.storagePath) {
    await getSupabase().storage.from(AGENT_KNOWLEDGE_BUCKET).remove([result.storagePath]).catch(() => {});
  }
  return true;
}

function safeFileName(fileName: string): string {
  const base = posix.basename(fileName.trim()).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 180);
  if (!base || base === '.' || base === '..') {
    throw new AgentKnowledgeInputError('invalid_file_name', 'File name is invalid.');
  }
  return base;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function equalToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(tokenHash(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createAgentKnowledgeUploadRecord(input: {
  accountId: string;
  projectId: string;
  agentName: string;
  userId: string;
  fileName: string;
  contentType: string;
  size: number;
}): Promise<{
  source: AgentKnowledgeSourceRecord;
  signedUploadUrl: string;
  uploadToken: string;
  storagePath: string;
  expiresAt: string;
}> {
  assertAgentName(input.agentName);
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > AGENT_KNOWLEDGE_MAX_FILE_SIZE) {
    throw new AgentKnowledgeInputError(
      'invalid_file_size',
      `Knowledge files must be between 1 byte and ${AGENT_KNOWLEDGE_MAX_FILE_SIZE} bytes.`,
    );
  }
  if (!AGENT_KNOWLEDGE_UPLOAD_MIME_TYPES.has(input.contentType)) {
    throw new AgentKnowledgeInputError('unsupported_file_type', 'This knowledge file type is not supported.');
  }
  const fileName = safeFileName(input.fileName);
  const sourceId = crypto.randomUUID();
  const storagePath = `${input.accountId}/${input.projectId}/${input.agentName}/${sourceId}/${fileName}`;
  const now = new Date();
  const [source] = await db
    .insert(agentKnowledgeSources)
    .values({
      sourceId,
      accountId: input.accountId,
      projectId: input.projectId,
      agentName: input.agentName,
      slug: sourceSlug(fileName.replace(/\.[^.]+$/, '')),
      sourceType: 'upload',
      title: fileName,
      status: 'draft',
      storagePath,
      sourceConfig: { fileName, contentType: input.contentType, size: input.size },
      automaticSync: false,
      syncIntervalHours: null,
      createdBy: input.userId,
      expiresAt: new Date(now.getTime() + SOURCE_EXPIRY_MS),
    })
    .returning();
  if (!source) throw new Error('Failed to create upload source.');

  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(AGENT_KNOWLEDGE_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false });
  if (error || !data?.signedUrl || !data.token) {
    await db.delete(agentKnowledgeSources).where(eq(agentKnowledgeSources.sourceId, sourceId));
    throw error ?? new Error('Failed to create signed upload URL.');
  }
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const sourceConfig = {
    ...(source.sourceConfig as Record<string, unknown>),
    uploadTokenHash: tokenHash(data.token),
    uploadExpiresAt: expiresAt,
  };
  const [updated] = await db
    .update(agentKnowledgeSources)
    .set({ sourceConfig, updatedAt: new Date() })
    .where(eq(agentKnowledgeSources.sourceId, sourceId))
    .returning();
  return {
    source: { ...(updated ?? source), activeVersion: null },
    signedUploadUrl: data.signedUrl,
    uploadToken: data.token,
    storagePath,
    expiresAt,
  };
}

export async function completeAgentKnowledgeUploadRecord(
  projectId: string,
  agentName: string,
  sourceId: string,
  uploadToken: string,
): Promise<AgentKnowledgeSourceRecord | null> {
  const source = await getAgentKnowledgeSourceRecord(projectId, agentName, sourceId);
  if (!source || source.sourceType !== 'upload' || !source.storagePath) return null;
  const config = source.sourceConfig as Record<string, unknown>;
  const expectedHash = typeof config.uploadTokenHash === 'string' ? config.uploadTokenHash : '';
  const expiresAt = typeof config.uploadExpiresAt === 'string' ? new Date(config.uploadExpiresAt) : null;
  if (!expectedHash || !equalToken(uploadToken, expectedHash) || !expiresAt || expiresAt < new Date()) {
    throw new AgentKnowledgeInputError('invalid_upload_token', 'Upload token is invalid or expired.');
  }

  const directory = posix.dirname(source.storagePath);
  const fileName = posix.basename(source.storagePath);
  const { data, error } = await getSupabase().storage
    .from(AGENT_KNOWLEDGE_BUCKET)
    .list(directory, { search: fileName, limit: 10 });
  if (error || !data?.some((entry) => entry.name === fileName)) {
    throw new AgentKnowledgeInputError('upload_not_found', 'Upload has not completed.');
  }
  const nextConfig = { ...config };
  delete nextConfig.uploadTokenHash;
  delete nextConfig.uploadExpiresAt;
  const [updated] = await db
    .update(agentKnowledgeSources)
    .set({ status: 'pending', sourceConfig: nextConfig, nextSyncAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(agentKnowledgeSources.projectId, projectId),
        eq(agentKnowledgeSources.agentName, agentName),
        eq(agentKnowledgeSources.sourceId, sourceId),
        ne(agentKnowledgeSources.status, 'revoked'),
      ),
    )
    .returning();
  if (!updated) return null;
  await enqueueAgentKnowledgeSync(projectId, agentName, sourceId);
  return { ...updated, activeVersion: null };
}
