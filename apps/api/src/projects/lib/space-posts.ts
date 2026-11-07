// Space posts (flag `chat`): an agent writes into a space for the person its
// session works for. The space's main chat is its shared feed.
//
// - A top-level post is a new thread whose first message is the agent's own
//   (`chat_root_text`, `chat_root_author`), as a Kortix-started chat thread
//   always was. A person's reply runs that thread with the space's agent.
// - A post into an existing thread is a cross-session message
//   (`peer-messages/service.ts`): the transcript draws it as "Message from
//   @handle". It is delivered `noReply` (it joins the transcript, no turn of
//   the thread's agent runs) unless the post asks for an answer (`ask`).
// - `@person` (display name, email or its local part) and `@agent` become
//   mentions. A mentioned person who may see the thread gets a `question`
//   notification that opens it; nobody else is notified. `@all` and `@here`
//   name nobody.
//
// Who may post: only a session, for its person, where that person may post
// themself: a channel the session can see (a private channel only from its
// own threads, `spaceAccessFor`), or a private space the person owns (a
// `dm` row: their personal space, or their private space with an agent), from a private
// session that works only for them (`threadWorksOnlyForPerson`).
import { projectSessions, projectSpaceMembers } from '@kortix/db';
import { isMyKortixAgentName, SPACE_POST_SUMMARY } from '@kortix/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Actor } from '../../iam/actor';
import { db } from '../../shared/db';
import { canSeeSpace, spaceAccessFor } from '../../shared/space-access';
import { isUuid } from '../../shared/validate';
import { loadProjectAgents } from '../agents';
import { loadPeerSession, PeerMessageError, sendPeerMessage } from '../peer-messages/service';
import { CHAT_AGENT, CHAT_ROOT_TEXT_KEY, sessionThread, threadWorksOnlyForPerson } from './chat-threads';
import { findLiveSpace } from './project-spaces';
import type { SessionCreateError } from './session-create';
import { logger } from '../../lib/logger';
import { deliver } from '../../notifications/notifier';
import { loadSessionAccessRows, maySeeSessions } from '../../notifications/access';
import { mentionTokens } from './mentions';
import { loadProjectRosterIds } from './project-access-view';
import { isWatcherOfSpace } from './space-watch/store';
import { resolveUserIdentities } from './user-identity';
import { projectsView } from '../../workspaces/rows';

/** Session metadata: the agent that wrote a top-level post (its name), when it was not the thread's agent. */
export const CHAT_ROOT_AUTHOR_KEY = 'chat_root_author';
/** Session metadata: the mentions of a top-level post, as the UI draws them. */
export const CHAT_ROOT_MENTIONS_KEY = 'chat_root_mentions';

export interface PostMention {
  /** The `@token` as written, without `@`, lowercased. */
  token: string;
  kind: 'person' | 'agent';
  /** A person's user id; null for an agent. */
  userId: string | null;
  /** What the chip shows: the display name, or the agent's name. */
  label: string;
}

/** A person as a mention may name them. */
export interface MentionCandidate {
  userId: string;
  displayName: string | null;
  email: string | null;
}

/**
 * A person's own message in a channel thread (the web's `@` menu writes
 * `@<email>` or `@<display-name-slug>`): each person it mentions who may see
 * the thread gets one notification, keyed by the message so a retried turn
 * writes nothing new. The author is never notified. Never throws. Called off
 * the turn's path (`sandbox-proxy/forward/turn-start.ts`).
 */
export async function notifyMessageMentions(input: {
  projectId: string;
  sessionId: string;
  authorId: string;
  text: string;
  messageKey: string;
}): Promise<string[]> {
  try {
    if (!input.text.includes('@')) return [];
    const [row] = await db
      .select({ accountId: projectsView.accountId, spaceId: projectSessions.spaceId })
      .from(projectSessions)
      .innerJoin(projectsView, eq(projectsView.projectId, projectSessions.projectId))
      .where(and(eq(projectSessions.sessionId, input.sessionId), eq(projectSessions.projectId, input.projectId)))
      .limit(1);
    if (!row?.spaceId) return [];
    const space = await findLiveSpace(input.projectId, row.spaceId);
    if (!space || space.kind !== 'channel') return [];
    const people = await projectMentionCandidates({ accountId: row.accountId, projectId: input.projectId });
    const mentions = resolveMentions(input.text, people, []).filter((m) => m.kind === 'person' && m.userId !== input.authorId);
    if (mentions.length === 0) return [];
    const author = people.find((p) => p.userId === input.authorId);
    return await notifyMentions({
      accountId: row.accountId,
      projectId: input.projectId,
      threadSessionId: input.sessionId,
      postKey: `message:${input.messageKey}`,
      place: `#${space.slug ?? space.name}`,
      author: author?.displayName?.trim() || author?.email?.split('@')[0] || 'Someone',
      text: input.text,
      mentions,
    });
  } catch (error) {
    logger.warn('[space-posts] message mention notifications were not sent', {
      session_id: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** A name as one `@` token: `Ana Lima` → `ana-lima`. */
const slug = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9._@+-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * The mentions of a post (pure): each `@token` that names a person (display
 * name as a slug, the email, or its local part) or an agent of the project.
 * A token names at most one person; an ambiguous one names nobody. `@all` and
 * `@here` are never mentions.
 */
export function resolveMentions(text: string, people: readonly MentionCandidate[], agents: readonly string[]): PostMention[] {
  const out: PostMention[] = [];
  for (const token of mentionTokens(text)) {
    if (token === 'all' || token === 'here') continue;
    const hits = people.filter((p) => {
      const email = p.email?.toLowerCase() ?? '';
      const names = [p.displayName ? slug(p.displayName) : '', email, email.split('@')[0] ?? ''].filter(Boolean);
      return names.includes(token);
    });
    if (hits.length === 1) {
      const person = hits[0]!;
      out.push({ token, kind: 'person', userId: person.userId, label: person.displayName?.trim() || (person.email?.split('@')[0] ?? token) });
      continue;
    }
    const agent = agents.find((name) => slug(name) === token || (token === 'kortix' && isMyKortixAgentName(name)));
    if (agent) out.push({ token, kind: 'agent', userId: null, label: agent });
  }
  return out;
}

/**
 * True when every @mention of a member's message names another person (and
 * there is at least one): the message is for them, not for the thread's
 * agent. `@all`, `@here`, an agent, the author or an unknown name: false.
 */
export function addressesOnlyPeople(text: string, people: readonly MentionCandidate[], authorId: string): boolean {
  const tokens = mentionTokens(text);
  if (tokens.size === 0) return false;
  const persons = resolveMentions(text, people, []).filter((m) => m.kind === 'person' && m.userId !== authorId);
  return persons.length === tokens.size;
}

/** `addressesOnlyPeople` for a session's message: the project's people read only when the text has an @. Never throws. */
export async function messageAddressesOnlyPeople(input: { accountId: string; projectId: string; authorId: string; text: string }): Promise<boolean> {
  if (!input.text.includes('@')) return false;
  try {
    return addressesOnlyPeople(input.text, await projectMentionCandidates(input), input.authorId);
  } catch (error) {
    logger.warn('[space-posts] the message mentions were not read; the agent answers', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** The project's people as mention candidates. */
export async function projectMentionCandidates(project: { accountId: string; projectId: string }): Promise<MentionCandidate[]> {
  const { ids } = await loadProjectRosterIds({ row: project });
  const identities = await resolveUserIdentities([...ids]);
  return [...ids].map((userId) => {
    const who = identities.get(userId);
    return { userId, displayName: who?.displayName ?? null, email: who?.email ?? null };
  });
}

/**
 * Notify each mentioned person who may see the thread: one `question` row
 * that opens it, keyed by the post so a retry writes nothing new. Returns the
 * people notified. Never throws.
 */
export async function notifyMentions(input: {
  accountId: string;
  projectId: string;
  threadSessionId: string;
  postKey: string;
  place: string;
  author: string;
  text: string;
  mentions: readonly PostMention[];
}): Promise<string[]> {
  try {
    const people = [...new Set(input.mentions.flatMap((m) => (m.userId ? [m.userId] : [])))];
    if (people.length === 0) return [];
    const rows = [...(await loadSessionAccessRows([input.threadSessionId])).values()];
    const allowed: string[] = [];
    for (const userId of people) {
      if ((await maySeeSessions(userId, rows)).has(input.threadSessionId)) allowed.push(userId);
    }
    if (allowed.length === 0) return [];
    const body = input.text.replace(/\s+/g, ' ').trim();
    await deliver({
      kind: 'question',
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.threadSessionId,
      title: `${input.author} mentioned you in ${input.place}`,
      body: body.length > 280 ? `${body.slice(0, 279)}…` : body,
      dedupeKey: `space-post:${input.postKey}`,
      recipients: allowed,
    });
    return allowed;
  } catch (error) {
    logger.warn('[space-posts] mention notifications were not sent', {
      session_id: input.threadSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export interface StartThreadSpec {
  person: string;
  spaceId: string;
  agentName: string;
  visibility: 'private' | 'project';
  metadata: Record<string, unknown>;
}

export type PostOutcome =
  | { status: 201 | 403 | 404 | 409 | 429 | 503; body: Record<string, unknown> }
  | { createError: SessionCreateError };

const notFound = { status: 404 as const, body: { error: 'Space not found', code: 'space_not_found' } };

/**
 * One agent post, for the person the calling session works for (see the
 * header). `startThread` creates a top-level thread (the route owns the
 * request-bound session create). Never posts where the person may not.
 */
export async function postIntoSpace(input: {
  project: { accountId: string; projectId: string };
  callerSessionId: string;
  spaceId: string;
  text: string;
  threadId: string | null;
  ask: boolean;
  actor: Actor | null;
  agentMayPrompt: boolean;
  startThread: (spec: StartThreadSpec) => Promise<{ sessionId: string | null } | { error: SessionCreateError }>;
}): Promise<PostOutcome> {
  const { project, callerSessionId } = input;
  const projectId = project.projectId;
  const thread = await sessionThread(projectId, callerSessionId);
  if (!thread) return { status: 409, body: { error: 'This session works for no person', code: 'no_person' } };
  const person = thread.personId;
  const space = isUuid(input.spaceId) ? await findLiveSpace(projectId, input.spaceId) : null;
  // Another person's DM, or a channel this session cannot see, does not exist for it.
  if (!space || (space.kind === 'dm' && space.dmUserId !== person)) return notFound;
  // The space's own watcher (`spaces_proactive`) is filed in no space: it sees its space as its person does.
  const bound = (await isWatcherOfSpace(callerSessionId, space.spaceId)) ? null : callerSessionId;
  if (!canSeeSpace(space, await spaceAccessFor(projectId, person, bound))) return notFound;
  // A DM is the person's own: only a session whose prompts come from them alone writes there.
  if (space.kind === 'dm' && !(await threadWorksOnlyForPerson(projectId, thread))) {
    return { status: 403, body: { error: 'Only a private session that works only for this person posts into their private space', code: 'not_the_persons_chat' } };
  }
  const sender = await loadPeerSession(callerSessionId);
  if (!sender) return notFound;
  const authorAgent = sender.agentName ?? CHAT_AGENT;
  const [candidates, agents] = await Promise.all([projectMentionCandidates(project), projectAgentNames(projectId)]);
  // Only people who are in the space are mention candidates: a private channel's members, a DM's owner.
  const inSpace = space.kind === 'dm'
    ? new Set([person])
    : space.visibility === 'private'
      ? new Set((await db.select({ userId: projectSpaceMembers.userId }).from(projectSpaceMembers).where(eq(projectSpaceMembers.spaceId, space.spaceId))).map((r) => r.userId))
      : null;
  const people = inSpace ? candidates.filter((c) => inSpace.has(c.userId)) : candidates;
  const mentions = resolveMentions(input.text, people, [...new Set([CHAT_AGENT, ...agents])]);
  // A `dm` row is the person's own space (My Kortix) or their private space with an agent: never "direct message".
  const place = space.kind === 'channel' ? `#${space.slug ?? space.name}` : 'your space';
  const author = isMyKortixAgentName(authorAgent) ? 'Kortix' : authorAgent;
  // A person's user id rides along: the web opens their card from the chip.
  const wire = mentions.map(({ token, kind, label, userId }) => ({ token, kind, label, ...(userId ? { userId } : {}) }));

  if (input.threadId) {
    const target = isUuid(input.threadId) ? await topLevelThreadIn(projectId, space.spaceId, input.threadId) : null;
    if (!target) return { status: 404, body: { error: 'No thread with that id in this space', code: 'thread_not_found' } };
    try {
      const outcome = await sendPeerMessage({
        sender,
        body: { to: target, message: input.text, summary: SPACE_POST_SUMMARY },
        caller: {
          actor: input.actor ?? { userId: person, accountId: project.accountId, credential: { kind: 'jwt' }, ctx: {} },
          userId: person,
          agentMayPrompt: input.agentMayPrompt,
        },
        noReply: !input.ask,
      });
      if (outcome.kind !== 'result' || (outcome.result.status !== 'delivered' && outcome.result.status !== 'held')) {
        return { status: 403, body: { error: outcome.kind === 'result' ? outcome.result.note : outcome.message, code: 'not_posted' } };
      }
      const notified = await notifyMentions({
        accountId: project.accountId, projectId, threadSessionId: target,
        postKey: outcome.result.message?.id ?? `${callerSessionId}:${target}:${Date.now()}`,
        place, author, text: input.text, mentions,
      });
      return { status: 201, body: { session_id: target, kind: 'reply', notified, mentions: wire } };
    } catch (err) {
      if (err instanceof PeerMessageError) return { status: err.status === 400 ? 403 : err.status, body: { error: err.message, code: err.code } };
      throw err;
    }
  }

  const threadAgent = space.kind === 'dm' ? (space.dmAgentName ?? CHAT_AGENT) : (space.agents?.[0] ?? CHAT_AGENT);
  const started = await input.startThread({
    person,
    spaceId: space.spaceId,
    agentName: threadAgent,
    // A channel's threads are its members'; a DM's are its owner's.
    visibility: space.kind === 'dm' ? 'private' : 'project',
    metadata: {
      [CHAT_ROOT_TEXT_KEY]: input.text,
      ...(authorAgent !== threadAgent ? { [CHAT_ROOT_AUTHOR_KEY]: authorAgent } : {}),
      ...(wire.length ? { [CHAT_ROOT_MENTIONS_KEY]: wire } : {}),
    },
  });
  if ('error' in started) return { createError: started.error };
  if (!started.sessionId) return { status: 503, body: { error: 'The post could not be made' } };
  const notified = await notifyMentions({
    accountId: project.accountId, projectId, threadSessionId: started.sessionId, postKey: started.sessionId, place, author, text: input.text, mentions,
  });
  return { status: 201, body: { session_id: started.sessionId, kind: 'thread', notified, mentions: wire } };
}

/** The id of a live top-level thread of the space, or null. */
async function topLevelThreadIn(projectId: string, spaceId: string, sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.projectId, projectId),
      eq(projectSessions.spaceId, spaceId),
      isNull(projectSessions.parentSessionId),
      sql`coalesce(${projectSessions.metadata}->>'deletedAt', '') = ''`,
    ))
    .limit(1);
  return row?.sessionId ?? null;
}

/** The project's agent names, for `@agent` mentions; [] when the manifest cannot be read. */
async function projectAgentNames(projectId: string): Promise<string[]> {
  try {
    const [row] = await db.select().from(projectsView).where(eq(projectsView.projectId, projectId)).limit(1);
    if (!row) return [];
    return (await loadProjectAgents(row)).specs.map((spec) => spec.name);
  } catch {
    return [];
  }
}
