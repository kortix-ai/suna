/**
 * Thread files (flag `chat`): a space thread's shared folder in the space's
 * Drive folder. The conversation itself is never copied here: it is the
 * thread's session log, read with `kortix sessions log <session_id>` (the
 * `GET .../sessions/:id/log` route), always current.
 *
 * | Path (inside the space folder)               | What                                  |
 * |----------------------------------------------|---------------------------------------|
 * | `context.md`                                 | the space's brief, made with a heading on first use |
 * | `threads/<slug>-<short id>/work/<worker>/`   | a worker's scratch folder             |
 * | `threads/<…>/results/<worker>-<n>.md`        | a worker's full result: the router links it, never retypes it |
 *
 * The space folder is `spaceDriveFolders(...).files`: `/Company/Channels/<slug>`,
 * `/Channels/<space_id>` (private), or `<person>/Agents/<agent>` (a DM). Every
 * session of the thread mounts it (`planSessionDrives`).
 *
 * The thread folder's name comes from the root session's `first_prompt`, set
 * once at create. A thread from before this change keeps the name stored in
 * its `thread_files` metadata.
 */
import { AGENT_HANDLE_KEY } from '@kortix/api-contract/multi-agent';
import { isMyKortixAgentName, spaceDriveFolders } from '@kortix/shared';
import { sql } from 'drizzle-orm';
import { mountedAt, type NotesMount, oneLine } from '../drives/folders';
import { findProjectDrive, listFolderGrants, personalFolderFor, readSessionDriveMounts, type DriveRow } from '../drives/service';
import { DriveStorageError } from '../drives/volumes';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { volumeOps } from './volume-ops';

/** Root-session metadata key of a thread from before this change: its folder name. Read only. */
export const THREAD_FILES_METADATA_KEY = 'thread_files';

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
  return { space: spaceFolder, context: `${spaceFolder}/context.md`, folder, work: `${folder}/work` };
}

/** `context.md` as first made: a heading only. */
export function contextFileText(place: string): string {
  return `# ${oneLine(place)}: context\n`;
}

/** The folder name a thread from before this change stored in `thread_files`, or null. */
export function storedThreadDir(metadata: unknown): string | null {
  const raw = ((metadata ?? {}) as Record<string, unknown>)[THREAD_FILES_METADATA_KEY] as Record<string, unknown> | undefined;
  return raw && typeof raw === 'object' && typeof raw.dir === 'string' && /^[a-z0-9-]{1,64}$/.test(raw.dir) ? raw.dir : null;
}

/** The thread's folder name: the stored one, else from the root's `first_prompt`. */
export function threadDirOf(rootSessionId: string, rootMetadata: unknown): string {
  const firstPrompt = ((rootMetadata ?? {}) as Record<string, unknown>).first_prompt;
  return storedThreadDir(rootMetadata) ?? threadDirName(rootSessionId, typeof firstPrompt === 'string' ? firstPrompt : null);
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

/** The thread's sandbox paths, as the session's mounts show them. */
export interface ThreadSandboxFiles {
  folder: string;
  context: string;
  /** The thread's conversation: its root session, read with `kortix sessions log`. */
  session: string;
}

export interface ThreadTurn {
  /** The "## Thread files" section of the turn's `system` text. */
  system: string;
  /** For the prompt body (`thread_files`): the router's Context files block reads it. Null when not mounted. */
  files: ThreadSandboxFiles | null;
}

/** How an agent reads the thread's conversation: the one source, never a copy. */
export function conversationLine(rootSessionId: string): string {
  return `The conversation: session ${rootSessionId}. Read it with \`kortix sessions log ${rootSessionId} -n 50\` (\`--json\` for scripts, pipe to rg or jq to search). It is always current; never copy it into a file.`;
}

/** The "## Thread files" section (pure). */
export function threadFilesSection(input: {
  place: string;
  rootSessionId: string;
  folder: string | null;
  context: string | null;
  workFolder: string | null;
  driveFolder: string;
}): string {
  if (!input.folder) {
    return `## Thread files\n${conversationLine(input.rootSessionId)}\nThis thread's files are in Drive at ${input.driveFolder}/, which is not mounted in this session.`;
  }
  return [
    '## Thread files',
    conversationLine(input.rootSessionId),
    `- Thread folder: ${input.folder}/ (work/<name>/ is each agent's scratch; results/ holds each agent's full result)`,
    ...(input.context ? [`- Brief of ${oneLine(input.place)}: ${input.context} (what every thread here should know; add to it when you learn something lasting)`] : []),
    ...(input.workFolder ? [`- Your work folder: ${input.workFolder}/ (scratch files; your full result goes to ${input.folder}/results/${input.workFolder.split('/').pop()}-<n>.md, <n> the next free number from 1)`] : []),
  ].join('\n');
}

export interface MessageAttachment {
  filename: string | null;
  mime: string | null;
  url: string | null;
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

/**
 * A turn of a session in a space thread: every session of the thread (workers
 * too) gets the "## Thread files" section, and the root's prompt body gets
 * `thread_files` for the router's Context files block. The space's
 * `context.md` is made on first use, off the turn's path. Null when the
 * session is in no space or the project has no Drive. The caller checked
 * `chat` is on.
 */
export async function threadFilesTurn(input: { sessionId: string }): Promise<ThreadTurn | null> {
  const row = await readThreadPlace(input.sessionId);
  if (!row?.space_id || !volumeOps().available()) return null;
  const drive = await findProjectDrive(row.project_id);
  if (!drive) return null;
  const grants = row.space_kind === 'dm' ? await listFolderGrants(drive) : [];
  const spaceFolder = spaceFolderOf(row, (userId) => personalFolderFor(grants, userId));
  if (!spaceFolder) return null;
  const isRoot = row.session_id === row.root_session_id;
  const paths = threadDrivePaths(spaceFolder, threadDirOf(row.root_session_id, row.root_metadata));
  if (isRoot) void ensureContextFile(drive, paths.context, placeName(row));
  const mounts = (await readSessionDriveMounts(input.sessionId)) as NotesMount[];
  const at = (path: string) => mountedAt(path, mounts);
  const folder = at(paths.folder);
  const context = at(paths.context);
  const handle = ((row.metadata ?? {}) as Record<string, unknown>)[AGENT_HANDLE_KEY];
  const workFolder = !isRoot && folder && typeof handle === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(handle) ? `${folder}/work/${handle}` : null;
  return {
    system: threadFilesSection({ place: placeName(row), rootSessionId: row.root_session_id, folder, context, workFolder, driveFolder: paths.folder }),
    files: isRoot && folder && context ? { folder, context, session: row.root_session_id } : null,
  };
}

/** `context.md` when the space has none yet; one that exists stays as it is. Never throws. */
async function ensureContextFile(drive: DriveRow, path: string, place: string): Promise<void> {
  try {
    await volumeOps().write(drive, path, contextFileText(place), { overwrite: false });
  } catch (error) {
    if (error instanceof DriveStorageError && error.status === 409) return;
    logger.warn('[thread-files] context.md was not made', { path, error: error instanceof Error ? error.message : String(error) });
  }
}
