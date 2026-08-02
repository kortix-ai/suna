import {
  type AgentKnowledgeLocator,
  agentKnowledgeChunks,
  agentKnowledgeSources,
  agentKnowledgeVersions,
  agentKnowledgeAssignments,
  agentProfileTestSessions,
  projectSessions,
} from '@kortix/db';
import { and, desc, eq, gt, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../shared/db';
import {
  type KnowledgeEmbeddingResult,
  embedKnowledgeTexts,
} from './agent-knowledge-embeddings';
import { reciprocalRankFusion } from './agent-knowledge-chunking';

export class SessionKnowledgeAccessError extends Error {
  constructor(readonly code: 'forbidden' | 'session_not_found', message: string) {
    super(message);
    this.name = 'SessionKnowledgeAccessError';
  }
}

interface SearchCandidate {
  chunkId: string;
  citationId: string;
  sourceId: string;
  sourceSlug: string;
  sourceTitle: string;
  versionId: string;
  content: string;
  locator: AgentKnowledgeLocator;
  score: number;
}

export interface SessionKnowledgeCitation {
  citation_id: string;
  source_id: string;
  source_slug: string;
  source_title: string;
  version_id: string;
  locator: AgentKnowledgeLocator;
}

export interface SessionKnowledgeSearchResponse {
  results: Array<{
    content: string;
    score: number;
    lexical_score: number | null;
    vector_score: number | null;
    citation: SessionKnowledgeCitation;
  }>;
  mode: 'hybrid' | 'lexical';
  degraded_reason: string | null;
}

async function resolveSession(input: {
  projectId: string;
  requestedSessionId: string;
  authenticatedSessionId: string | null;
}) {
  if (!input.authenticatedSessionId || input.authenticatedSessionId !== input.requestedSessionId) {
    throw new SessionKnowledgeAccessError(
      'forbidden',
      'Knowledge access requires the authenticated project session.',
    );
  }
  const [session] = await db
    .select({
      sessionId: projectSessions.sessionId,
      accountId: projectSessions.accountId,
      projectId: projectSessions.projectId,
      agentName: projectSessions.agentName,
    })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.sessionId, input.requestedSessionId),
        eq(projectSessions.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!session) {
    throw new SessionKnowledgeAccessError('session_not_found', 'Project session was not found.');
  }
  return session;
}

async function assignedSourceIds(session: Awaited<ReturnType<typeof resolveSession>>) {
  const [draftGrant] = await db
    .select({ sourceIds: agentProfileTestSessions.sourceIds })
    .from(agentProfileTestSessions)
    .where(
      and(
        eq(agentProfileTestSessions.sessionId, session.sessionId),
        eq(agentProfileTestSessions.accountId, session.accountId),
        eq(agentProfileTestSessions.projectId, session.projectId),
        eq(agentProfileTestSessions.agentName, session.agentName),
        gt(agentProfileTestSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (draftGrant) return draftGrant.sourceIds;
  const assignments = await db
    .select({ sourceId: agentKnowledgeAssignments.sourceId })
    .from(agentKnowledgeAssignments)
    .where(
      and(
        eq(agentKnowledgeAssignments.accountId, session.accountId),
        eq(agentKnowledgeAssignments.projectId, session.projectId),
        eq(agentKnowledgeAssignments.agentName, session.agentName),
        eq(agentKnowledgeAssignments.active, true),
      ),
    );
  return assignments.map((assignment) => assignment.sourceId);
}

function activeChunkConditions(
  session: Awaited<ReturnType<typeof resolveSession>>,
  sourceIds: string[],
) {
  return and(
    eq(agentKnowledgeChunks.accountId, session.accountId),
    eq(agentKnowledgeChunks.projectId, session.projectId),
    eq(agentKnowledgeChunks.agentName, session.agentName),
    eq(agentKnowledgeSources.accountId, session.accountId),
    eq(agentKnowledgeSources.projectId, session.projectId),
    eq(agentKnowledgeSources.agentName, session.agentName),
    eq(agentKnowledgeSources.activeVersionId, agentKnowledgeChunks.versionId),
    inArray(agentKnowledgeChunks.sourceId, sourceIds),
    ne(agentKnowledgeSources.status, 'revoked'),
    eq(agentKnowledgeVersions.status, 'active'),
  );
}

function candidateSelection(score: ReturnType<typeof sql<number>>) {
  return {
    chunkId: agentKnowledgeChunks.chunkId,
    citationId: agentKnowledgeChunks.citationId,
    sourceId: agentKnowledgeChunks.sourceId,
    sourceSlug: agentKnowledgeSources.slug,
    sourceTitle: agentKnowledgeSources.title,
    versionId: agentKnowledgeChunks.versionId,
    content: agentKnowledgeChunks.content,
    locator: agentKnowledgeChunks.locator,
    score,
  };
}

function toCitation(candidate: SearchCandidate): SessionKnowledgeCitation {
  return {
    citation_id: candidate.citationId,
    source_id: candidate.sourceId,
    source_slug: candidate.sourceSlug,
    source_title: candidate.sourceTitle,
    version_id: candidate.versionId,
    locator: candidate.locator,
  };
}

export async function searchAgentKnowledgeForSession(input: {
  projectId: string;
  requestedSessionId: string;
  authenticatedSessionId: string | null;
  query: string;
  limit?: number;
  embedQuery?: (texts: string[]) => Promise<KnowledgeEmbeddingResult>;
}): Promise<SessionKnowledgeSearchResponse> {
  const query = input.query.trim();
  if (!query || query.length > 8_000) throw new Error('Knowledge query must contain 1 to 8000 characters.');
  const limit = input.limit ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('Knowledge result limit must be between 1 and 20.');
  }
  const session = await resolveSession(input);
  const sourceIds = await assignedSourceIds(session);
  if (sourceIds.length === 0) {
    return { results: [], mode: 'lexical', degraded_reason: null };
  }
  const candidateLimit = Math.max(32, limit * 4);

  const assignedVersions = await db
    .select({ lexicalOnly: agentKnowledgeVersions.lexicalOnly })
    .from(agentKnowledgeVersions)
    .innerJoin(
      agentKnowledgeSources,
      and(
        eq(agentKnowledgeSources.activeVersionId, agentKnowledgeVersions.versionId),
        eq(agentKnowledgeSources.accountId, session.accountId),
        eq(agentKnowledgeSources.projectId, session.projectId),
        eq(agentKnowledgeSources.agentName, session.agentName),
        inArray(agentKnowledgeSources.sourceId, sourceIds),
        ne(agentKnowledgeSources.status, 'revoked'),
      ),
    )
    .where(eq(agentKnowledgeVersions.status, 'active'));

  if (assignedVersions.length === 0) {
    return { results: [], mode: 'lexical', degraded_reason: null };
  }

  const lexicalScore = sql<number>`ts_rank_cd(
    ${agentKnowledgeChunks.searchDocument},
    websearch_to_tsquery('english', ${query})
  )`.mapWith(Number);
  const lexicalRows = (await db
    .select(candidateSelection(lexicalScore))
    .from(agentKnowledgeChunks)
    .innerJoin(agentKnowledgeSources, eq(agentKnowledgeSources.sourceId, agentKnowledgeChunks.sourceId))
    .innerJoin(agentKnowledgeVersions, eq(agentKnowledgeVersions.versionId, agentKnowledgeChunks.versionId))
    .where(
      and(
        activeChunkConditions(session, sourceIds),
        sql`${agentKnowledgeChunks.searchDocument} @@ websearch_to_tsquery('english', ${query})`,
      ),
    )
    .orderBy(desc(lexicalScore), agentKnowledgeChunks.chunkId)
    .limit(candidateLimit)) as SearchCandidate[];

  const allLexicalOnly = assignedVersions.every((version) => version.lexicalOnly);
  let vectorRows: SearchCandidate[] = [];
  let mode: 'hybrid' | 'lexical' = 'lexical';
  let degradedReason: string | null = allLexicalOnly
    ? 'Assigned sources are currently available through lexical search only.'
    : null;

  if (!allLexicalOnly) {
    const embed =
      input.embedQuery ??
      ((texts: string[]) =>
        embedKnowledgeTexts(texts, {
          apiKey: config.OPENAI_API_KEY,
          baseUrl: config.OPENAI_API_URL,
        }));
    const embedded = await embed([query]);
    const queryEmbedding = embedded.embeddings?.[0];
    if (!embedded.lexicalOnly && queryEmbedding) {
      mode = 'hybrid';
      const vectorLiteral = JSON.stringify(queryEmbedding);
      const vectorScore = sql<number>`1 - (${agentKnowledgeChunks.embedding} <=> ${vectorLiteral}::vector)`.mapWith(Number);
      vectorRows = (await db
        .select(candidateSelection(vectorScore))
        .from(agentKnowledgeChunks)
        .innerJoin(agentKnowledgeSources, eq(agentKnowledgeSources.sourceId, agentKnowledgeChunks.sourceId))
        .innerJoin(agentKnowledgeVersions, eq(agentKnowledgeVersions.versionId, agentKnowledgeChunks.versionId))
        .where(and(activeChunkConditions(session, sourceIds), isNotNull(agentKnowledgeChunks.embedding)))
        .orderBy(desc(vectorScore), agentKnowledgeChunks.chunkId)
        .limit(candidateLimit)) as SearchCandidate[];
      if (assignedVersions.some((version) => version.lexicalOnly)) {
        degradedReason = 'Some assigned sources are currently available through lexical search only.';
      }
    } else {
      degradedReason = embedded.degradedReason;
    }
  }

  const byId = new Map([...lexicalRows, ...vectorRows].map((candidate) => [candidate.chunkId, candidate]));
  const fused = reciprocalRankFusion(
    lexicalRows.map((candidate) => ({ id: candidate.chunkId, score: candidate.score })),
    vectorRows.map((candidate) => ({ id: candidate.chunkId, score: candidate.score })),
    limit,
  );
  return {
    results: fused.flatMap((ranked) => {
      const candidate = byId.get(ranked.id);
      return candidate
        ? [
            {
              content: candidate.content,
              score: ranked.score,
              lexical_score: ranked.lexicalScore,
              vector_score: ranked.vectorScore,
              citation: toCitation(candidate),
            },
          ]
        : [];
    }),
    mode,
    degraded_reason: degradedReason,
  };
}

export async function readAgentKnowledgeForSession(input: {
  projectId: string;
  requestedSessionId: string;
  authenticatedSessionId: string | null;
  citationId: string;
}): Promise<{ content: string; citation: SessionKnowledgeCitation } | null> {
  const session = await resolveSession(input);
  const sourceIds = await assignedSourceIds(session);
  if (sourceIds.length === 0) return null;
  const [candidate] = (await db
    .select(candidateSelection(sql<number>`0`.mapWith(Number)))
    .from(agentKnowledgeChunks)
    .innerJoin(agentKnowledgeSources, eq(agentKnowledgeSources.sourceId, agentKnowledgeChunks.sourceId))
    .innerJoin(agentKnowledgeVersions, eq(agentKnowledgeVersions.versionId, agentKnowledgeChunks.versionId))
    .where(
      and(
        activeChunkConditions(session, sourceIds),
        eq(agentKnowledgeChunks.citationId, input.citationId),
      ),
    )
    .limit(1)) as SearchCandidate[];
  return candidate ? { content: candidate.content, citation: toCitation(candidate) } : null;
}
