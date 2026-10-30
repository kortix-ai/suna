/**
 * What the session slash commands DO, as plain async functions over the one
 * `kortix()` client.
 *
 * `app.tsx` decides WHEN (it owns the open session, the toasts and the
 * route); this file decides HOW, one SDK call each, and returns the sentence
 * the user reads. Every function takes the client as a parameter so a test
 * passes a fake one — no module mock, no network.
 */

import type { kortix as kortixClient } from '../kortix.ts';

export type Client = ReturnType<typeof kortixClient>;

/** A thrown value as one readable line. */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

export async function renameSession(
  client: Client,
  projectId: string,
  sessionId: string,
  title: string,
): Promise<string> {
  const name = title.trim();
  if (!name) throw new Error('Type a title after /rename.');
  await client.session(projectId, sessionId).update({ name });
  return `Renamed to ${name}.`;
}

export async function deleteSession(
  client: Client,
  projectId: string,
  sessionId: string,
): Promise<string> {
  await client.session(projectId, sessionId).delete();
  return 'Session deleted. It stays in Recently deleted for 30 days.';
}

export async function restartSession(
  client: Client,
  projectId: string,
  sessionId: string,
): Promise<string> {
  await client.session(projectId, sessionId).restart();
  return 'Restarting the sandbox. The conversation is kept.';
}

export async function compactSession(
  client: Client,
  projectId: string,
  sessionId: string,
): Promise<string> {
  await client.session(projectId, sessionId).compact();
  return 'Compacting the conversation…';
}

export async function togglePin(
  client: Client,
  projectId: string,
  sessionId: string,
  pinned: boolean,
): Promise<string> {
  await client.session(projectId, sessionId).setPinned(!pinned);
  return pinned ? 'Unpinned.' : 'Pinned to the top of /sessions.';
}

/**
 * Archive the open session, or bring it back. The list leaves out archived
 * sessions, so the current state is read from the session itself.
 */
export async function toggleArchive(
  client: Client,
  projectId: string,
  sessionId: string,
): Promise<{ message: string; archived: boolean }> {
  const handle = client.session(projectId, sessionId);
  const current = (await handle.get()) as { archived_at?: string | null } | null;
  const archived = !current?.archived_at;
  await handle.setArchived(archived);
  return {
    archived,
    message: archived ? 'Archived. It no longer shows in /sessions.' : 'Restored from the archive.',
  };
}

/** `/share team|private`. Private needs the owner, read from the session. */
export async function shareSession(
  client: Client,
  projectId: string,
  sessionId: string,
  mode: string,
): Promise<string> {
  const handle = client.session(projectId, sessionId);
  const word = mode.trim().toLowerCase();
  if (word === 'team' || word === 'project') {
    await handle.setSharing({ mode: 'project' });
    return 'Everyone in this project can open this session.';
  }
  if (word === 'private' || word === 'me') {
    const current = (await handle.get()) as { created_by?: string | null } | null;
    const ownerId = current?.created_by;
    if (!ownerId) throw new Error('This session has no owner on record.');
    await handle.setSharing({ mode: 'private', ownerId });
    return 'Only the owner can open this session.';
  }
  throw new Error('Type /share team or /share private.');
}

export async function reloadSession(
  client: Client,
  projectId: string,
  sessionId: string,
): Promise<string> {
  await client.session(projectId, sessionId).reloadConfig();
  return 'Reloaded kortix.yaml, agents and skills.';
}

/** `/new <prompt>` and the draft's first prompt. Titles are server-owned: none sent. */
export async function startSession(
  client: Client,
  projectId: string,
  prompt: string,
): Promise<string> {
  const text = prompt.trim();
  const created = await client.projects.createSession(
    projectId,
    text ? { initial_prompt: text } : {},
  );
  return created.session_id;
}

/** `/fork [prompt]`: the conversation so far, copied into a new session. */
export async function forkSession(
  client: Client,
  projectId: string,
  sessionId: string,
  prompt: string,
): Promise<string> {
  const text = prompt.trim();
  const created = await client.projects.createSession(projectId, {
    fork_from_session_id: sessionId,
    ...(text ? { initial_prompt: text } : {}),
  });
  return created.session_id;
}

/** The web page of a session, for `/copy`. */
export function sessionWebUrl(webBase: string, projectId: string, sessionId: string): string {
  return `${webBase.replace(/\/+$/, '')}/projects/${projectId}/sessions/${sessionId}`;
}
