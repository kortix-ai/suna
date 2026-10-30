import { accountMembers, artifactComments, artifactCommentThreads, artifactEvents, jobQueue, projectSessions, projects, type ArtifactCommentMention } from '@kortix/db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';
import type { ArtifactRow } from './service';
import { artifactAgentMentionToken } from './comment-tokens';

export type { ArtifactCommentMention } from '@kortix/db';

export async function resolveArtifactCommentMentions(artifact: ArtifactRow, body: string): Promise<ArtifactCommentMention[]> {
  const { loadProjectAgents, mentionTokens, mentionsMember, resolveUserIdentities } = await import('../projects/surface');
  const tokens = mentionTokens(body);
  if (!tokens.size) return [];
  const members = await db.select({ userId: accountMembers.userId }).from(accountMembers).where(eq(accountMembers.accountId, artifact.accountId));
  const users = await resolveUserIdentities(members.map((member) => member.userId));
  const peopleTokens = new Set([...tokens].filter((token) => !token.startsWith('agent.')));
  const people = members.filter((member) => {
    const identity = users.get(member.userId);
    return mentionsMember(peopleTokens, { ids: [member.userId], names: [identity?.displayName, identity?.email].filter((name): name is string => !!name) });
  }).map((member) => member.userId);
  const { filterArtifactRecipients } = await import('../notifications/access');
  const allowedPeople = await filterArtifactRecipients(artifact, people);
  const mentions: ArtifactCommentMention[] = allowedPeople.map((user_id) => ({ kind: 'user', user_id }));
  const agentTokens = new Set([...tokens].filter((token) => token !== 'all' && token !== 'here'));
  if (!agentTokens.size) return mentions;
  const ownSession = artifact.createdBySessionId ? await db.select({ id: projectSessions.sessionId, agent: projectSessions.agentName }).from(projectSessions)
    .where(and(eq(projectSessions.accountId, artifact.accountId), eq(projectSessions.projectId, artifact.projectId), eq(projectSessions.sessionId, artifact.createdBySessionId))) : [];
  const rawAgentTokens = new Set([...agentTokens].filter((token) => !token.startsWith('agent.')));
  for (const session of ownSession) {
    if (mentionsMember(rawAgentTokens, { ids: [session.id], names: [session.agent] })) mentions.push({ kind: 'session', session_id: session.id, agent_name: session.agent });
  }
  const matchedTokens = new Set([...agentTokens].filter((token) => !token.startsWith('agent.') && (members.some((member) => {
    const identity = users.get(member.userId);
    return mentionsMember(new Set([token]), { ids: [member.userId], names: [identity?.displayName, identity?.email].filter((name): name is string => !!name) });
  }) || ownSession.some((session) => mentionsMember(new Set([token]), { ids: [session.id], names: [session.agent] })))));
  const unresolved = new Set([...agentTokens].filter((token) => !matchedTokens.has(token)));
  if (!unresolved.size) return mentions;
  const [project] = await db.select().from(projects).where(and(eq(projects.projectId, artifact.projectId), eq(projects.accountId, artifact.accountId)));
  if (!project) return mentions;
  const agents = await loadProjectAgents(project, { rethrowReadErrors: true });
  for (const token of unresolved) {
    for (const agent of agents.specs) {
      if (agent.enabled && (token.startsWith('agent.') ? token === artifactAgentMentionToken(agent.name).slice(1) : mentionsMember(new Set([token]), { ids: [], names: [agent.name] }))
        && !mentions.some((mention) => mention.kind !== 'user' && mention.agent_name === agent.name)) {
        const source = ownSession.find((session) => session.agent === agent.name);
        mentions.push(source ? { kind: 'session', session_id: source.id, agent_name: agent.name } : { kind: 'agent', agent_name: agent.name });
      }
    }
  }
  return mentions;
}

export interface ArtifactAgentRecipient { recipientKey: string; sessionId?: string; agentName: string; createKey?: string; originCommentId?: string }

export async function artifactCommentOriginIsCurrent(
  artifact: Pick<ArtifactRow, 'artifactId' | 'projectId'>, threadIds: readonly string[],
  recipient: Pick<ArtifactAgentRecipient, 'recipientKey' | 'originCommentId'>, executor: Pick<typeof db, 'select'> = db,
): Promise<boolean> {
  if (!recipient.originCommentId) return true;
  if (!threadIds.length || !isUuid(recipient.originCommentId)) return false;
  const [comment] = await executor.select({ row: artifactComments }).from(artifactComments)
    .innerJoin(artifactCommentThreads, eq(artifactCommentThreads.threadId, artifactComments.threadId))
    .where(and(eq(artifactComments.commentId, recipient.originCommentId), inArray(artifactComments.threadId, [...threadIds]),
      eq(artifactCommentThreads.artifactId, artifact.artifactId), eq(artifactCommentThreads.projectId, artifact.projectId)));
  if (!comment || comment.row.deletedAt || !comment.row.mentions.some((mention) =>
    (mention.kind === 'session' && `session:${mention.session_id}` === recipient.recipientKey)
    || (mention.kind === 'agent' && `agent:${mention.agent_name}` === recipient.recipientKey))) return false;
  const [root] = await executor.select({ deleted: artifactComments.deletedAt }).from(artifactComments).where(eq(artifactComments.threadId, comment.row.threadId))
    .orderBy(asc(artifactComments.createdAt), asc(artifactComments.commentId)).limit(1);
  return !!root && !root.deleted;
}

export async function priorArtifactAgentTargets(artifact: ArtifactRow, threadIds: string[], executor: Pick<typeof db, 'select'> = db): Promise<ArtifactAgentRecipient[]> {
  const [threads, events, pending] = await Promise.all([
    executor.select({ created: artifactCommentThreads.createdBySessionId }).from(artifactCommentThreads)
      .where(and(eq(artifactCommentThreads.artifactId, artifact.artifactId), inArray(artifactCommentThreads.threadId, threadIds))),
    executor.select({ data: artifactEvents.data }).from(artifactEvents).where(and(eq(artifactEvents.artifactId, artifact.artifactId), eq(artifactEvents.type, 'sent_to_agent')))
      .orderBy(desc(artifactEvents.createdAt), desc(artifactEvents.eventId)),
    executor.select({ payload: jobQueue.payload }).from(jobQueue).where(and(eq(jobQueue.queue, 'artifact-comment-agents'), eq(jobQueue.status, 'queued'),
      sql`${jobQueue.payload}->>'artifactId' = ${artifact.artifactId}`)).orderBy(desc(jobQueue.createdAt), desc(jobQueue.jobId)),
  ]);
  const recipients = new Map<string, ArtifactAgentRecipient>();
  for (const { data } of events) {
    if (!threadIds.includes(String(data.thread_id)) || typeof data.session_id !== 'string' || typeof data.agent_name !== 'string') continue;
    const key = typeof data.recipient_key === 'string' ? data.recipient_key : `session:${data.session_id}`;
    const recipient = { recipientKey: key, sessionId: data.session_id, agentName: data.agent_name,
      ...(typeof data.origin_comment_id === 'string' ? { originCommentId: data.origin_comment_id } : {}) };
    if (!recipients.has(key) && await artifactCommentOriginIsCurrent(artifact, threadIds, recipient, executor)) recipients.set(key, recipient);
  }
  for (const { payload } of pending) {
    if (!Array.isArray(payload.threadIds) || !payload.threadIds.some((id) => threadIds.includes(String(id))) || !Array.isArray(payload.targets)) continue;
    for (const target of payload.targets as Array<Record<string, unknown>>) {
      if (target.status === 'skipped' || target.status === 'failed' || typeof target.recipientKey !== 'string' || typeof target.sessionId !== 'string' || typeof target.agentName !== 'string' || recipients.has(target.recipientKey)) continue;
      const source = typeof payload.commentId === 'string' ? await executor.select({ deleted: artifactComments.deletedAt }).from(artifactComments)
        .where(and(eq(artifactComments.commentId, payload.commentId), inArray(artifactComments.threadId, threadIds))) : [];
      if (payload.commentId && (!source.length || source[0]!.deleted)) continue;
      const recipient = { recipientKey: target.recipientKey, sessionId: target.sessionId, agentName: target.agentName,
        ...(typeof target.originCommentId === 'string' ? { originCommentId: target.originCommentId }
          : !target.implicit && typeof payload.commentId === 'string' ? { originCommentId: payload.commentId } : {}),
        ...(target.created && target.status !== 'sent' && typeof target.key === 'string' ? { createKey: target.key } : typeof target.createKey === 'string' ? { createKey: target.createKey } : {}) };
      if (await artifactCommentOriginIsCurrent(artifact, threadIds, recipient, executor)) recipients.set(target.recipientKey, recipient);
    }
  }
  const ids = threads.flatMap((thread) => thread.created ? [thread.created] : []);
  const sessions = ids.length ? await executor.select().from(projectSessions).where(and(eq(projectSessions.accountId, artifact.accountId), eq(projectSessions.projectId, artifact.projectId), inArray(projectSessions.sessionId, ids))) : [];
  for (const session of sessions) {
    if (!recipients.has(`session:${session.sessionId}`) && ![...recipients.values()].some((recipient) => recipient.sessionId === session.sessionId)) recipients.set(`session:${session.sessionId}`, { recipientKey: `session:${session.sessionId}`, sessionId: session.sessionId, agentName: session.agentName });
  }
  return [...recipients.values()];
}
