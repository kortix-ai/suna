/**
 * Thread files (flag `chat`): a space thread keeps its conversation as files
 * in the space's Drive folder, so every session of the thread (the router and
 * its workers) reads the same text by path instead of a retyped copy.
 *
 * | Path (inside the space folder)                      | What                                  |
 * |-----------------------------------------------------|---------------------------------------|
 * | `context.md`                                        | the space's brief, made with a heading on first use |
 * | `threads/<slug>-<short id>/messages/NNNN-<author>.md` | one file per message: front matter (author, time, session id, prompt id), then the text |
 * | `threads/<…>/work/<worker name>/`                   | a worker's scratch folder             |
 * | `threads/<…>/results/<worker name>-<n>.md`          | a worker's full result: the router links it, never retypes it |
 *
 * The space folder is `spaceDriveFolders(...).files`: `/Company/Channels/<slug>`,
 * `/Channels/<space_id>` (private), or `<person>/Agents/<agent>` (a DM). Every
 * session of the thread mounts it (`planSessionDrives`).
 *
 * The thread's numbering lives in its root session's metadata
 * (`thread_files`: folder name, last number, the number of each prompt id),
 * so a retried prompt keeps its file. The person's message is written when
 * the API forwards the prompt (`sandbox-proxy/forward/turn-start.ts`), the
 * agent's answer when its turn ends (`recordThreadReply`). Every write is best
 * effort and off the turn's path: a failure is logged, never shown.
 */
import { createHash } from 'node:crypto';
import { AGENT_HANDLE_KEY } from '@kortix/api-contract/multi-agent';
import { projectSessions } from '@kortix/db';
import { isMyKortixAgentName, spaceDriveFolders } from '@kortix/shared';
import { eq, sql } from 'drizzle-orm';
import { mountedAt, type NotesMount, oneLine } from '../drives/folders';
import { findProjectDrive, listFolderGrants, personalFolderFor, readSessionDriveMounts, type DriveRow } from '../drives/service';
import { DriveStorageError } from '../drives/volumes';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { memoryChannelsOn } from './turn-body';
import { volumeOps } from './volume-ops';

/** Root-session metadata key: the thread's folder name and message numbering. Server-managed. */
export const THREAD_FILES_METADATA_KEY = 'thread_files';
/** Prompt ids remembered per thread, newest kept: a retry of a recent prompt keeps its number. */
const REMEMBERED_IDS = 50;
const MESSAGE_TEXT_MAX = 200_000;

export interface ThreadFilesState {
  /** `<slug>-<short id>`, fixed at the thread's first message. */
  dir: string;
  /** The last number given. */
  seq: number;
  /** The number of each recent prompt or reply id. */
  ids: Record<string, number>;
}

/** A name as one lowercase file-name segment (`Ana Lima` → `ana-lima`); `fallback` when nothing is left. */
export function fileSlug(text: string, max: number, fallback: string): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || fallback;
}

/** The thread's folder name: the first words of its first message, then the session id's first 8 characters. */
export function threadDirName(sessionId: string, title: string | null): string {
  const words = (title ?? '').trim().split(/\s+/).slice(0, 6).join(' ');
  return `${fileSlug(words, 40, 'thread')}-${sessionId.replace(/-/g, '').slice(0, 8)}`;
}

/** The thread's Drive paths, from the space folder and the thread's folder name. */
export function threadDrivePaths(spaceFolder: string, dir: string) {
  const folder = `${spaceFolder}/threads/${dir}`;
  return { space: spaceFolder, context: `${spaceFolder}/context.md`, folder, messages: `${folder}/messages`, work: `${folder}/work` };
}

/** `0003-ana-lima.md`. */
export function messageFileName(n: number, author: string): string {
  return `${String(n).padStart(4, '0')}-${fileSlug(author, 32, 'member')}.md`;
}

/** A file name for an agent's messages: My Kortix writes as `kortix`. */
export function agentAuthor(agentName: string | null): string {
  return !agentName || isMyKortixAgentName(agentName) ? 'kortix' : agentName;
}

export interface MessageAttachment {
  filename: string | null;
  mime: string | null;
  url: string | null;
}

/** One message file (pure): front matter, the text, then the attachments it references. */
export function messageFileText(input: {
  author: string;
  role: 'person' | 'agent';
  at: Date;
  sessionId: string;
  id: string | null;
  text: string;
  attachments?: readonly MessageAttachment[];
}): string {
  const front = [
    '---',
    `author: ${JSON.stringify(oneLine(input.author).slice(0, 80))}`,
    `role: ${input.role}`,
    `time: ${input.at.toISOString()}`,
    `session_id: ${input.sessionId}`,
    ...(input.id ? [`id: ${JSON.stringify(oneLine(input.id).slice(0, 120))}`] : []),
    '---',
  ];
  const files = (input.attachments ?? []).map((file) => {
    const name = oneLine(file.filename ?? 'attachment');
    // A data: URL is the file itself: too large for a line. Only a link is referenced.
    const link = file.url && /^https?:\/\//.test(file.url) && file.url.length <= 2_000 ? ` <${file.url}>` : '';
    return `- ${name}${file.mime ? ` (${oneLine(file.mime)})` : ''}${link}`;
  });
  const body = input.text.length > MESSAGE_TEXT_MAX ? `${input.text.slice(0, MESSAGE_TEXT_MAX)}\n\n[cut at ${MESSAGE_TEXT_MAX} characters]` : input.text;
  return [...front, '', body.trim(), ...(files.length ? ['', '## Attachments', ...files] : []), ''].join('\n');
}

/** `context.md` as first made: a heading only. */
export function contextFileText(place: string): string {
  return `# ${oneLine(place)}: context\n`;
}

/**
 * The number for `key` (a prompt or reply id), pure: the number it already
 * has, else the next one. `fresh` is false for a key seen before (a retry).
 */
export function nextThreadNumber(
  state: ThreadFilesState | null,
  key: string,
  dirOf: () => string,
): { state: ThreadFilesState; n: number; fresh: boolean } {
  const base: ThreadFilesState = state ?? { dir: dirOf(), seq: 0, ids: {} };
  const seen = base.ids[key];
  if (typeof seen === 'number') return { state: base, n: seen, fresh: false };
  const n = base.seq + 1;
  const ids = Object.fromEntries([...Object.entries(base.ids), [key, n] as const].slice(-REMEMBERED_IDS));
  return { state: { dir: base.dir, seq: n, ids }, n, fresh: true };
}

/** A stored `thread_files` value, or null when it is missing or malformed. */
export function readThreadFilesState(metadata: unknown): ThreadFilesState | null {
  const raw = ((metadata ?? {}) as Record<string, unknown>)[THREAD_FILES_METADATA_KEY] as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.dir !== 'string' || !/^[a-z0-9-]{1,64}$/.test(raw.dir)) return null;
  const seq = typeof raw.seq === 'number' && Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0;
  const ids: Record<string, number> = {};
  if (raw.ids && typeof raw.ids === 'object') {
    for (const [k, v] of Object.entries(raw.ids as Record<string, unknown>)) if (typeof v === 'number') ids[k] = v;
  }
  return { dir: raw.dir, seq, ids };
}

/** Give `key` its number in the root session's `thread_files`, under the row lock. */
export async function allocateThreadNumber(rootSessionId: string, key: string, title: string | null): Promise<{ dir: string; n: number; fresh: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, rootSessionId))
      .for('update');
    const next = nextThreadNumber(readThreadFilesState(row?.metadata), key, () => threadDirName(rootSessionId, title));
    if (next.fresh) {
      await tx
        .update(projectSessions)
        // A top-level merge under the row lock: other metadata keys written meanwhile stay.
        .set({ metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ [THREAD_FILES_METADATA_KEY]: next.state })}::jsonb` })
        .where(eq(projectSessions.sessionId, rootSessionId));
    }
    return { dir: next.state.dir, n: next.n, fresh: next.fresh };
  });
}

/** One read: the session, its thread's root and the space the root is filed in. */
export interface ThreadPlaceRow {
  session_id: string;
  project_id: string;
  account_id: string;
  parent_session_id: string | null;
  agent_name: string | null;
  metadata: unknown;
  root_session_id: string;
  root_metadata: unknown;
  root_agent_name: string | null;
  root_created_by: string | null;
  space_id: string | null;
  space_kind: 'channel' | 'dm' | null;
  space_slug: string | null;
  space_name: string | null;
  space_visibility: 'public' | 'private' | null;
  /** The thread root's own sharing: a channel thread forked from a private or restricted transcript is not `project`. */
  thread_visibility?: 'project' | 'private' | 'restricted' | null;
  space_dm_user_id: string | null;
  space_dm_agent: string | null;
}

const MAX_DEPTH = 20;

export async function readThreadPlace(sessionId: string): Promise<ThreadPlaceRow | null> {
  const rows = (await db.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT session_id, parent_session_id, project_id, 0 AS depth
        FROM kortix.project_sessions WHERE session_id = ${sessionId}
      UNION ALL
      SELECT p.session_id, p.parent_session_id, p.project_id, c.depth + 1
        FROM kortix.project_sessions p JOIN chain c ON p.session_id = c.parent_session_id
       WHERE c.depth < ${MAX_DEPTH} AND p.project_id = c.project_id
    ),
    root AS (SELECT session_id FROM chain ORDER BY depth DESC LIMIT 1)
    SELECT s.session_id, s.project_id, pr.account_id, s.parent_session_id, s.agent_name, s.metadata,
           r.session_id AS root_session_id, r.metadata AS root_metadata, r.agent_name AS root_agent_name, r.created_by AS root_created_by,
           r.visibility::text AS thread_visibility,
           sp.space_id, sp.kind::text AS space_kind, sp.slug AS space_slug, sp.name AS space_name,
           sp.visibility::text AS space_visibility, sp.dm_user_id AS space_dm_user_id, sp.dm_agent_name AS space_dm_agent
      FROM kortix.project_sessions s
      JOIN kortix.projects pr ON pr.project_id = s.project_id
      JOIN root ON true
      JOIN kortix.project_sessions r ON r.session_id = root.session_id
      LEFT JOIN kortix.project_spaces sp ON sp.space_id = r.space_id AND sp.project_id = r.project_id
     WHERE s.session_id = ${sessionId}
     LIMIT 1
  `)) as unknown as ThreadPlaceRow[];
  return rows[0] ?? null;
}

/** "#general", the person's personal space (My Kortix), or their private space with an agent: never "DM". */
export function placeName(row: Pick<ThreadPlaceRow, 'space_kind' | 'space_slug' | 'space_name' | 'space_dm_agent'>): string {
  if (row.space_kind === 'channel') return `#${row.space_slug ?? row.space_name ?? 'channel'}`;
  return row.space_dm_agent && isMyKortixAgentName(row.space_dm_agent)
    ? "the person's personal space"
    : `the person's private space with ${row.space_dm_agent ?? 'an agent'}`;
}

/** The space's files folder in Drive (`grants` for a DM's owner folder); null when it has none. */
export function spaceFolderOf(row: ThreadPlaceRow, personalFolder: (userId: string) => string | null): string | null {
  if (!row.space_id || !row.space_kind) return null;
  if (row.space_kind === 'channel') {
    if (!row.space_slug) return null;
    // Every session filed in the channel mounts this folder read-write, so a thread
    // the channel does not publish keeps its files out of it.
    if (row.thread_visibility != null && row.thread_visibility !== 'project') return null;
    return spaceDriveFolders('channel', row.space_slug, null, row.space_visibility === 'private' ? row.space_id : null)?.files ?? null;
  }
  if (!row.space_dm_user_id || !row.space_dm_agent) return null;
  const personal = personalFolder(row.space_dm_user_id);
  return personal ? (spaceDriveFolders('dm', row.space_dm_agent, personal)?.files ?? null) : null;
}

/** Write a new file; one that exists stays as it is (a retry). */
async function writeOnce(drive: DriveRow, path: string, text: string): Promise<'written' | 'exists'> {
  try {
    await volumeOps().write(drive, path, text, { overwrite: false });
    return 'written';
  } catch (error) {
    if (error instanceof DriveStorageError && error.status === 409) return 'exists';
    throw error;
  }
}

/** The thread's sandbox paths, as the session's mounts show them. */
export interface ThreadSandboxFiles {
  folder: string;
  context: string;
  /** This turn's message file; absent on a turn with no message of a person. */
  message?: string;
}

export interface ThreadTurn {
  /** The "## Thread files" section of the turn's `system` text. */
  system: string;
  /** For the prompt body (`thread_files`): the router's Context files block reads it. Null when not mounted. */
  files: ThreadSandboxFiles | null;
}

/** The "## Thread files" section (pure). */
export function threadFilesSection(input: {
  place: string;
  folder: string | null;
  context: string | null;
  message: string | null;
  workFolder: string | null;
  driveFolder: string;
}): string {
  if (!input.folder) {
    return `## Thread files\nThis thread's files are in Drive at ${input.driveFolder}/, which is not mounted in this session.`;
  }
  return [
    '## Thread files',
    `This thread lives in files, shared by every agent that works on it. Read a file by its path instead of asking for its text again.`,
    `- Thread folder: ${input.folder}/ (messages/ holds one file per message, oldest first; work/<name>/ is each agent's scratch; results/ holds each agent's full result)`,
    ...(input.context ? [`- Brief of ${oneLine(input.place)}: ${input.context} (what every thread here should know; add to it when you learn something lasting)`] : []),
    ...(input.message ? [`- This message: ${input.message}`] : []),
    ...(input.workFolder ? [`- Your work folder: ${input.workFolder}/ (scratch files; your full result goes to ${input.folder}/results/${input.workFolder.split('/').pop()}-<n>.md, <n> the next free number from 1)`] : []),
  ].join('\n');
}

/** A Kortix prompt body's message of a person: its non-synthetic text and its attachments. Null for a notice (all synthetic). */
export function personMessageOf(body: ArrayBuffer | undefined): { id: string | null; text: string; attachments: MessageAttachment[] } | null {
  if (!body?.byteLength) return null;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.noReply === true || !Array.isArray(parsed.parts)) return null;
  const text: string[] = [];
  const attachments: MessageAttachment[] = [];
  for (const part of parsed.parts as Array<Record<string, unknown>>) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.synthetic !== true) text.push(part.text);
    if (part.type === 'file') {
      attachments.push({
        filename: typeof part.filename === 'string' ? part.filename : null,
        mime: typeof part.mime === 'string' ? part.mime : null,
        url: typeof part.url === 'string' ? part.url : null,
      });
    }
  }
  const joined = text.join('').trim();
  if (!joined && attachments.length === 0) return null;
  return { id: typeof parsed.messageID === 'string' ? parsed.messageID : null, text: joined, attachments };
}

/** Same id, same number: a re-sent body without an id is keyed by its text. */
function promptKey(id: string | null, text: string): string {
  if (id) return `p:${id}`;
  return `t:${createHash('sha256').update(text).digest('hex').slice(0, 24)}`;
}

/**
 * A turn of a session in a space thread: the person's message (a top-level
 * thread's non-synthetic prompt) gets its number now and its file off the
 * turn's path; every session of the thread (workers too) gets the
 * "## Thread files" section. Null when the session is in no space or the
 * project has no Drive. The caller checked `chat` is on.
 */
export async function threadFilesTurn(input: {
  sessionId: string;
  userId: string | null;
  body: ArrayBuffer | undefined;
  authorName: (userId: string) => Promise<string>;
}): Promise<ThreadTurn | null> {
  const row = await readThreadPlace(input.sessionId);
  if (!row?.space_id || !volumeOps().available()) return null;
  const drive = await findProjectDrive(row.project_id);
  if (!drive) return null;
  const grants = row.space_kind === 'dm' ? await listFolderGrants(drive) : [];
  const spaceFolder = spaceFolderOf(row, (userId) => personalFolderFor(grants, userId));
  if (!spaceFolder) return null;
  const isRoot = row.session_id === row.root_session_id;
  const message = isRoot && input.userId ? personMessageOf(input.body) : null;
  let dir = readThreadFilesState(row.root_metadata)?.dir ?? null;
  let messagePath: string | null = null;
  if (message) {
    const firstPrompt = ((row.root_metadata ?? {}) as Record<string, unknown>).first_prompt;
    const allocated = await allocateThreadNumber(row.root_session_id, promptKey(message.id, message.text), typeof firstPrompt === 'string' ? firstPrompt : message.text);
    dir = allocated.dir;
    const author = await input.authorName(input.userId!).catch(() => 'A member');
    const paths = threadDrivePaths(spaceFolder, dir);
    messagePath = `${paths.messages}/${messageFileName(allocated.n, author)}`;
    void writeThreadMessage(drive, paths, placeName(row), messagePath, messageFileText({
      author,
      role: 'person',
      at: new Date(),
      sessionId: row.session_id,
      id: message.id,
      text: message.text,
      attachments: message.attachments,
    }));
  }
  if (!dir) dir = threadDirName(row.root_session_id, null);
  const paths = threadDrivePaths(spaceFolder, dir);
  const mounts = (await readSessionDriveMounts(input.sessionId)) as NotesMount[];
  const at = (path: string) => mountedAt(path, mounts);
  const folder = at(paths.folder);
  const context = at(paths.context);
  const messageAt = messagePath ? at(messagePath) : null;
  const handle = ((row.metadata ?? {}) as Record<string, unknown>)[AGENT_HANDLE_KEY];
  const workFolder = !isRoot && folder && typeof handle === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(handle) ? `${folder}/work/${handle}` : null;
  return {
    system: threadFilesSection({ place: placeName(row), folder, context, message: messageAt, workFolder, driveFolder: paths.folder }),
    files: isRoot && folder && context ? { folder, context, ...(messageAt ? { message: messageAt } : {}) } : null,
  };
}

/** The message file, and `context.md` when the space has none yet. Never throws. */
async function writeThreadMessage(drive: DriveRow, paths: ReturnType<typeof threadDrivePaths>, place: string, path: string, text: string): Promise<void> {
  try {
    await writeOnce(drive, paths.context, contextFileText(place));
    const outcome = await writeOnce(drive, path, text);
    logger.info('[thread-files] message file', { path, outcome });
  } catch (error) {
    logger.warn('[thread-files] the message file was not written', { path, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * At a top-level space thread's turn end: its agent's last answer as the
 * thread's next message file (`NNNN-<agent>.md`). Keyed by the answer's
 * message id, so a second turn-end report writes nothing new. Never throws.
 */
export async function recordThreadReply(
  sessionId: string,
  lastAnswer: (sessionId: string) => Promise<{ id: string | null; text: string } | null>,
): Promise<string | null> {
  try {
    const row = await readThreadPlace(sessionId);
    if (!row?.space_id || row.session_id !== row.root_session_id || !volumeOps().available()) return null;
    if (!(await memoryChannelsOn(row.project_id))) return null;
    const answer = await lastAnswer(sessionId);
    if (!answer?.text.trim()) return null;
    const drive = await findProjectDrive(row.project_id);
    if (!drive) return null;
    const grants = row.space_kind === 'dm' ? await listFolderGrants(drive) : [];
    const spaceFolder = spaceFolderOf(row, (userId) => personalFolderFor(grants, userId));
    if (!spaceFolder) return null;
    const firstPrompt = ((row.root_metadata ?? {}) as Record<string, unknown>).first_prompt;
    const key = answer.id ? `r:${answer.id}` : promptKey(null, answer.text);
    const allocated = await allocateThreadNumber(row.root_session_id, key, typeof firstPrompt === 'string' ? firstPrompt : null);
    if (!allocated.fresh) return null;
    const paths = threadDrivePaths(spaceFolder, allocated.dir);
    const author = agentAuthor(row.root_agent_name);
    const path = `${paths.messages}/${messageFileName(allocated.n, author)}`;
    await writeOnce(drive, paths.context, contextFileText(placeName(row)));
    await writeOnce(drive, path, messageFileText({ author: author === 'kortix' ? 'Kortix' : author, role: 'agent', at: new Date(), sessionId, id: answer.id, text: answer.text }));
    logger.info('[thread-files] reply file', { path });
    return path;
  } catch (error) {
    logger.warn('[thread-files] the reply file was not written', { session_id: sessionId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
