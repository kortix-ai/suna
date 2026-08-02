import { createHash } from 'node:crypto';
import {
  type Database,
  agentKnowledgeChunks,
  agentKnowledgeSources,
  agentKnowledgeSyncJobs,
  agentKnowledgeVersions,
} from '@kortix/db';
import { and, eq, ne, sql } from 'drizzle-orm';
import { config } from '../../config';
import { makeDbGatewayDeps } from '../../executor/db-deps';
import { handleCall } from '../../executor/gateway';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { getSupabase } from '../../shared/supabase';
import { retryPendingAgentProfileKnowledgeReconciliations } from './agent-knowledge-assignments';
import { chunkKnowledgeDocument } from './agent-knowledge-chunking';
import { type KnowledgeEmbeddingResult, embedKnowledgeTexts } from './agent-knowledge-embeddings';
import {
  type ExtractKnowledgeDocumentInput,
  extractKnowledgeDocument,
} from './agent-knowledge-extract';
import { AGENT_KNOWLEDGE_BUCKET, AGENT_KNOWLEDGE_MAX_FILE_SIZE } from './agent-knowledge-sources';
import { fetchAgentKnowledgeUrl } from './agent-knowledge-url';
import { cleanupExpiredAgentProfileArtifacts } from './agent-profile-cleanup';

type KnowledgeSource = typeof agentKnowledgeSources.$inferSelect;

interface LeasedSyncJob {
  jobId: string;
  accountId: string;
  projectId: string;
  agentName: string;
  sourceId: string;
  attempt: number;
  maxAttempts: number;
}

export interface AgentKnowledgeWorkerDependencies {
  database?: Database;
  workerId?: string;
  projectId?: string;
  leaseMs?: number;
  loadDocument?: (source: KnowledgeSource) => Promise<ExtractKnowledgeDocumentInput>;
  embedTexts?: (texts: string[]) => Promise<KnowledgeEmbeddingResult>;
}

const workerId = `${process.env.HOSTNAME ?? 'local'}:${process.pid}:${crypto.randomUUID()}`;
const EMBEDDING_BATCH_SIZE = 64;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const RETRY_BASE_MS = 30_000;

async function leaseNextJob(
  database: Database,
  owner: string,
  leaseMs: number,
  projectId?: string,
): Promise<LeasedSyncJob | null> {
  const rows = await database.execute<{
    job_id: string;
    account_id: string;
    project_id: string;
    agent_name: string;
    source_id: string;
    attempt: number;
    max_attempts: number;
  }>(sql`
    with candidate as (
      select job.job_id
      from kortix.agent_knowledge_sync_jobs job
      join kortix.agent_knowledge_sources source on source.source_id = job.source_id
      where job.attempt < job.max_attempts
        and source.status <> 'revoked'
        and (${projectId ?? null}::uuid is null or job.project_id = ${projectId ?? null}::uuid)
        and (
          (job.status = 'pending' and job.available_at <= now())
          or (job.status = 'running' and (job.lease_until is null or job.lease_until < now()))
        )
      order by job.available_at asc, job.created_at asc
      for update of job skip locked
      limit 1
    )
    update kortix.agent_knowledge_sync_jobs job
    set status = 'running',
        attempt = job.attempt + 1,
        lease_owner = ${owner},
        lease_until = now() + (${leaseMs} * interval '1 millisecond'),
        started_at = coalesce(job.started_at, now()),
        updated_at = now()
    from candidate
    where job.job_id = candidate.job_id
    returning job.job_id, job.account_id, job.project_id, job.agent_name,
              job.source_id, job.attempt, job.max_attempts
  `);
  const row = rows[0];
  return row
    ? {
        jobId: row.job_id,
        accountId: row.account_id,
        projectId: row.project_id,
        agentName: row.agent_name,
        sourceId: row.source_id,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
      }
    : null;
}

function connectedDocument(data: unknown, source: KnowledgeSource): ExtractKnowledgeDocumentInput {
  const record =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  const rawContent = record?.content ?? record?.text ?? record?.body ?? record?.data ?? data;
  const content =
    typeof rawContent === 'string'
      ? rawContent
      : rawContent == null
        ? ''
        : JSON.stringify(rawContent, null, 2);
  if (!content.trim()) {
    throw new Error(`Connected app returned no content for resource ${source.resourceId}.`);
  }
  const contentTypeValue = record?.content_type ?? record?.contentType ?? record?.mime_type;
  const fileNameValue = record?.file_name ?? record?.fileName ?? record?.name;
  return {
    body: new TextEncoder().encode(content),
    contentType:
      typeof contentTypeValue === 'string' && contentTypeValue.trim()
        ? contentTypeValue
        : 'text/plain',
    fileName:
      typeof fileNameValue === 'string' && fileNameValue.trim() ? fileNameValue : source.title,
  };
}

async function loadConnectedAppDocument(
  source: KnowledgeSource,
): Promise<ExtractKnowledgeDocumentInput> {
  const sourceConfig = source.sourceConfig as Record<string, unknown>;
  const connectorSlug = sourceConfig.connectorSlug;
  const readAction = sourceConfig.readAction;
  const resourceArgument = sourceConfig.resourceArgument;
  if (
    !source.connectorProfileId ||
    !source.resourceId ||
    typeof connectorSlug !== 'string' ||
    typeof readAction !== 'string' ||
    typeof resourceArgument !== 'string'
  ) {
    throw new Error('Connected-app knowledge source configuration is incomplete.');
  }

  const principal = {
    userId: source.createdBy,
    accountId: source.accountId,
    projectId: source.projectId,
    sessionId: null,
    subject: { userId: source.createdBy, groupIds: [] },
    agentGrant: null,
  };
  const gateway = makeDbGatewayDeps(principal, {
    profileIdOverride: source.connectorProfileId,
    // Selecting a specific read-only resource authorizes its recurring sync.
    enforcePolicies: false,
  });
  const loadAction = gateway.loadAction;
  gateway.loadAction = async (connectorId, actionPath) => {
    const action = await loadAction(connectorId, actionPath);
    return action?.risk === 'read' ? action : null;
  };
  const result = await handleCall(gateway, {
    projectId: source.projectId,
    accountId: source.accountId,
    subject: principal.subject,
    sessionId: null,
    connectorSlug,
    actionPath: readAction,
    args: { [resourceArgument]: source.resourceId },
  });
  if (result.status !== 'ok' || result.risk !== 'read') {
    const reason = 'reason' in result ? result.reason : 'read_action_required';
    throw new Error(`Connected app could not read resource ${source.resourceId}: ${reason}.`);
  }
  return connectedDocument(result.data, source);
}

async function loadDefaultDocument(
  source: KnowledgeSource,
): Promise<ExtractKnowledgeDocumentInput> {
  if (source.sourceType === 'url') {
    if (!source.url) throw new Error('Knowledge URL source has no URL.');
    const response = await fetchAgentKnowledgeUrl(source.url);
    return { ...response, fileName: new URL(response.url).pathname.split('/').pop() || undefined };
  }
  if (source.sourceType === 'upload') {
    if (!source.storagePath) throw new Error('Knowledge upload has no private storage path.');
    const { data, error } = await getSupabase()
      .storage.from(AGENT_KNOWLEDGE_BUCKET)
      .download(source.storagePath);
    if (error || !data) throw new Error(error?.message ?? 'Knowledge upload could not be read.');
    if (data.size > AGENT_KNOWLEDGE_MAX_FILE_SIZE) {
      throw new Error(`Knowledge upload exceeds ${AGENT_KNOWLEDGE_MAX_FILE_SIZE} bytes.`);
    }
    const sourceConfig = source.sourceConfig as Record<string, unknown>;
    return {
      body: new Uint8Array(await data.arrayBuffer()),
      contentType:
        (typeof sourceConfig.contentType === 'string' && sourceConfig.contentType) ||
        data.type ||
        'application/octet-stream',
      fileName: typeof sourceConfig.fileName === 'string' ? sourceConfig.fileName : source.title,
    };
  }
  return loadConnectedAppDocument(source);
}

async function embedAll(
  texts: string[],
  embed: (batch: string[]) => Promise<KnowledgeEmbeddingResult>,
): Promise<KnowledgeEmbeddingResult> {
  const embeddings: number[][] = [];
  let model: string | null = null;
  for (let index = 0; index < texts.length; index += EMBEDDING_BATCH_SIZE) {
    const result = await embed(texts.slice(index, index + EMBEDDING_BATCH_SIZE));
    if (result.lexicalOnly || !result.embeddings) return result;
    model = result.model;
    embeddings.push(...result.embeddings);
  }
  return { embeddings, model, lexicalOnly: false, degradedReason: null };
}

function exactError(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error)).trim() || 'Knowledge sync failed.'
  );
}

async function failJob(input: {
  database: Database;
  job: LeasedSyncJob;
  versionId: string | null;
  error: string;
}): Promise<void> {
  const now = new Date();
  const terminal = input.job.attempt >= input.job.maxAttempts;
  const retryDelay = Math.min(
    RETRY_BASE_MS * 2 ** Math.max(0, input.job.attempt - 1),
    6 * 60 * 60 * 1000,
  );
  await input.database.transaction(async (tx) => {
    if (input.versionId) {
      await tx
        .update(agentKnowledgeVersions)
        .set({ status: 'failed', error: input.error })
        .where(eq(agentKnowledgeVersions.versionId, input.versionId));
    }
    await tx
      .update(agentKnowledgeSources)
      .set({
        status: 'error',
        lastError: input.error,
        lastSyncAttemptAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentKnowledgeSources.sourceId, input.job.sourceId),
          eq(agentKnowledgeSources.projectId, input.job.projectId),
          eq(agentKnowledgeSources.agentName, input.job.agentName),
          ne(agentKnowledgeSources.status, 'revoked'),
        ),
      );
    await tx
      .update(agentKnowledgeSyncJobs)
      .set({
        status: terminal ? 'dead_lettered' : 'pending',
        availableAt: terminal ? now : new Date(now.getTime() + retryDelay),
        leaseOwner: null,
        leaseUntil: null,
        lastError: input.error,
        completedAt: terminal ? now : null,
        updatedAt: now,
      })
      .where(eq(agentKnowledgeSyncJobs.jobId, input.job.jobId));
  });
}

export async function processNextAgentKnowledgeSync(
  dependencies: AgentKnowledgeWorkerDependencies = {},
): Promise<{ jobId: string; sourceId: string; versionId: string } | null> {
  const database = dependencies.database ?? db;
  const owner = dependencies.workerId ?? workerId;
  const job = await leaseNextJob(
    database,
    owner,
    dependencies.leaseMs ?? DEFAULT_LEASE_MS,
    dependencies.projectId,
  );
  if (!job) return null;

  let versionId: string | null = null;
  try {
    const [source] = await database
      .select()
      .from(agentKnowledgeSources)
      .where(
        and(
          eq(agentKnowledgeSources.sourceId, job.sourceId),
          eq(agentKnowledgeSources.accountId, job.accountId),
          eq(agentKnowledgeSources.projectId, job.projectId),
          eq(agentKnowledgeSources.agentName, job.agentName),
          ne(agentKnowledgeSources.status, 'revoked'),
        ),
      )
      .limit(1);
    if (!source) throw new Error('Knowledge source is unavailable or revoked.');

    const [version] = await database
      .insert(agentKnowledgeVersions)
      .values({
        accountId: job.accountId,
        projectId: job.projectId,
        agentName: job.agentName,
        sourceId: job.sourceId,
        status: 'processing',
      })
      .returning({ versionId: agentKnowledgeVersions.versionId });
    if (!version) throw new Error('Knowledge version could not be created.');
    versionId = version.versionId;

    await database
      .update(agentKnowledgeSources)
      .set({ status: 'syncing', lastSyncAttemptAt: new Date(), updatedAt: new Date() })
      .where(eq(agentKnowledgeSources.sourceId, source.sourceId));
    const document = await (dependencies.loadDocument ?? loadDefaultDocument)(source);
    const blocks = await extractKnowledgeDocument(document);
    const chunks = chunkKnowledgeDocument(blocks);
    if (chunks.length === 0) throw new Error('Knowledge document contains no indexable text.');

    const embed =
      dependencies.embedTexts ??
      ((texts: string[]) =>
        embedKnowledgeTexts(texts, {
          apiKey: config.OPENAI_API_KEY,
          baseUrl: config.OPENAI_API_URL,
        }));
    const embeddingResult = await embedAll(
      chunks.map((chunk) => chunk.content),
      embed,
    );
    const values = chunks.map((chunk, chunkIndex) => ({
      accountId: job.accountId,
      projectId: job.projectId,
      agentName: job.agentName,
      sourceId: job.sourceId,
      versionId: version.versionId,
      chunkIndex,
      content: chunk.content,
      tokenCount: chunk.tokenCount,
      locator: chunk.locator,
      embedding: embeddingResult.embeddings?.[chunkIndex] ?? null,
    }));
    for (let index = 0; index < values.length; index += 100) {
      await database.insert(agentKnowledgeChunks).values(values.slice(index, index + 100));
    }

    const now = new Date();
    const contentHash = createHash('sha256')
      .update(chunks.map((chunk) => chunk.content).join('\n\u0000\n'))
      .digest('hex');
    await database.transaction(async (tx) => {
      const [promotedSource] = await tx
        .update(agentKnowledgeSources)
        .set({
          activeVersionId: version.versionId,
          status: embeddingResult.lexicalOnly ? 'degraded' : 'ready',
          lastSuccessfulSyncAt: now,
          lastSyncAttemptAt: now,
          nextSyncAt:
            source.automaticSync && source.syncIntervalHours
              ? new Date(now.getTime() + source.syncIntervalHours * 60 * 60 * 1000)
              : null,
          lastError: embeddingResult.degradedReason,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentKnowledgeSources.sourceId, source.sourceId),
            eq(agentKnowledgeSources.projectId, job.projectId),
            eq(agentKnowledgeSources.agentName, job.agentName),
            ne(agentKnowledgeSources.status, 'revoked'),
          ),
        )
        .returning({ previousVersionId: agentKnowledgeSources.activeVersionId });
      if (!promotedSource) throw new Error('Knowledge source was revoked during synchronization.');
      if (source.activeVersionId && source.activeVersionId !== version.versionId) {
        await tx
          .update(agentKnowledgeVersions)
          .set({ status: 'superseded' })
          .where(eq(agentKnowledgeVersions.versionId, source.activeVersionId));
      }
      await tx
        .update(agentKnowledgeVersions)
        .set({
          status: 'active',
          contentHash,
          chunkCount: chunks.length,
          embeddingModel: embeddingResult.model,
          lexicalOnly: embeddingResult.lexicalOnly,
          metadata: embeddingResult.degradedReason
            ? { degraded_reason: embeddingResult.degradedReason }
            : {},
          error: null,
          promotedAt: now,
        })
        .where(eq(agentKnowledgeVersions.versionId, version.versionId));
      await tx
        .update(agentKnowledgeSyncJobs)
        .set({
          status: 'succeeded',
          leaseOwner: null,
          leaseUntil: null,
          lastError: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(agentKnowledgeSyncJobs.jobId, job.jobId));
    });
    return { jobId: job.jobId, sourceId: source.sourceId, versionId: version.versionId };
  } catch (error) {
    await failJob({ database, job, versionId, error: exactError(error) });
    return { jobId: job.jobId, sourceId: job.sourceId, versionId: versionId ?? '' };
  }
}

export async function enqueueDueAgentKnowledgeSyncs(database: Database = db): Promise<number> {
  const rows = await database.execute<{ job_id: string }>(sql`
    insert into kortix.agent_knowledge_sync_jobs (
      account_id, project_id, agent_name, source_id, status, available_at
    )
    select source.account_id, source.project_id, source.agent_name, source.source_id,
           'pending', now()
    from kortix.agent_knowledge_sources source
    where source.automatic_sync = true
      and source.revoked_at is null
      and source.next_sync_at is not null
      and source.next_sync_at <= now()
      and source.status in ('ready', 'degraded', 'error')
    on conflict do nothing
    returning job_id
  `);
  return rows.length;
}

export async function runAgentKnowledgeSyncTick(): Promise<{
  enqueued: number;
  processed: number;
}> {
  await cleanupExpiredAgentProfileArtifacts();
  await retryPendingAgentProfileKnowledgeReconciliations().catch((error) =>
    logger.error('[agent-profile] knowledge reconciliation sweep failed', {
      error: exactError(error),
    }),
  );
  const enqueued = await enqueueDueAgentKnowledgeSyncs();
  const batch = Math.max(1, Number(process.env.KORTIX_AGENT_KNOWLEDGE_WORKER_BATCH) || 5);
  let processed = 0;
  for (let index = 0; index < batch; index += 1) {
    const result = await processNextAgentKnowledgeSync();
    if (!result) break;
    processed += 1;
  }
  return { enqueued, processed };
}

type Timer = ReturnType<typeof setInterval>;
let timer: Timer | null = null;
let running = false;

export function startAgentKnowledgeWorker(): void {
  if (process.env.KORTIX_AGENT_KNOWLEDGE_WORKER_ENABLED === 'false' || timer) return;
  const intervalMs = Math.max(
    1_000,
    Number(process.env.KORTIX_AGENT_KNOWLEDGE_WORKER_INTERVAL_MS) || 15_000,
  );
  const tick = () => {
    if (running) return;
    running = true;
    runAgentKnowledgeSyncTick()
      .catch((error) =>
        logger.error('[agent-knowledge-worker] tick failed', { error: exactError(error) }),
      )
      .finally(() => {
        running = false;
      });
  };
  tick();
  timer = setInterval(tick, intervalMs);
}

export function stopAgentKnowledgeWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
