/**
 * Memory layers: one Drive folder each. No row is stored.
 *
 * | Key          | Folder                               | Who reads it        |
 * |--------------|--------------------------------------|---------------------|
 * | `company`    | `/Company/Memory`                    | every project member |
 * | a channel id | `/Company/Channels/<slug>/Memory`    | every project member |
 * | a private channel id | `/Channels/<space_id>/Memory` | the channel's members only |
 * | a DM id      | `/Users/<owner>/Memory`, agent folder `Memory/<agent>` first | the DM owner only |
 *
 * Read and write rights are the Drive folder rights (`driveSubjectFor`), so a
 * narrower grant made in Files holds here too. A private channel is first
 * checked against membership (`canSeeSpace`): anyone else, a project manager
 * included, gets 404. An archived channel is read-only.
 */
import { COMPANY_MEMORY_DIR, MEMORY_DIR_NAME } from '../drives/folders';
import { folderAccess, folderAccessAtLeast } from '../drives/folders';
import { type DriveCaller, type DriveRow, driveSubjectFor, ensureProjectDrive, personalFolderFor } from '../drives/service';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { projectSessions, projectSpaces } from '@kortix/db';
import { resolveUserIdentities } from '../projects/surface';
import { spaceDriveFolders } from '@kortix/shared';
import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';
import { hiddenSpaceIds } from '../shared/space-access';
import type { MemoryLayerScope } from '@kortix/api-contract';
import { volumeOps } from './volume-ops';

/** A refusal with its HTTP status and machine code; the route answers `{error, code, ...extra}`. */
export class MemoryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 503,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }

  get body(): { error: string; code: string } & Record<string, unknown> {
    return { ...this.extra, error: this.message, code: this.code };
  }
}

export const notFound = () => new MemoryError(404, 'memory_not_found', 'Memory not found.');

/** Who asks: a person, and their project rights (`session`: a member; `write`: an admin). */
export interface Viewer {
  userId: string;
  may: (action: 'session' | 'write') => Promise<boolean>;
}

export interface Project {
  projectId: string;
  accountId: string;
  metadata: unknown;
}

export interface Layer {
  /** `company` or the space id. */
  key: string;
  scope: MemoryLayerScope;
  spaceId: string | null;
  /** "Company", "#marketing", or the DM's agent. */
  name: string;
  projectId: string;
  drive: DriveRow;
  /** The layer folder, a Drive path. */
  root: string;
  /** A DM's agent folder (inside `root`); null for others. */
  agentFolder: string | null;
  /** Folders inside `root` that belong to another layer (the owner's other DM agents). */
  skip: string[];
  readOnly: boolean;
  canWrite: boolean;
  /** The project's `#general`: a write there completes a Get started row. */
  isDefault: boolean;
}

/** 403 `feature_disabled` while Files is off: every memory route answers it first. */
export function assertFilesOn(project: Project): void {
  if (!resolveFeatureFlag(project.metadata, 'drives')) {
    throw new MemoryError(403, 'feature_disabled', 'Memory lives in Files. Turn on Files for this project first.', { feature: 'drives' });
  }
}

// One driveSubjectFor per request and viewer: a search resolves several layers.
const callers = new WeakMap<Viewer, Promise<{ drive: DriveRow; caller: DriveCaller }>>();

/** The project drive and the viewer's folder rights on it. 403 with Drive off, 503 without storage. */
function driveCallerOf(project: Project, viewer: Viewer): Promise<{ drive: DriveRow; caller: DriveCaller }> {
  let memo = callers.get(viewer);
  if (!memo) {
    memo = (async () => {
      assertFilesOn(project);
      if (!volumeOps().available()) throw new MemoryError(503, 'drive_storage_unavailable', 'Drive storage is not available.');
      const drive = await ensureProjectDrive(project.accountId, project.projectId);
      return { drive, caller: await driveSubjectFor(drive, viewer.userId, viewer.may) };
    })();
    callers.set(viewer, memo);
  }
  return memo;
}

const SPACE_COLUMNS = {
  spaceId: projectSpaces.spaceId,
  kind: projectSpaces.kind,
  slug: projectSpaces.slug,
  dmUserId: projectSpaces.dmUserId,
  dmAgentName: projectSpaces.dmAgentName,
  archivedAt: projectSpaces.archivedAt,
  isDefault: projectSpaces.isDefault,
  visibility: projectSpaces.visibility,
};

/** The DM agents of `userId` in the project, by space id. */
export async function dmAgentsOf(projectId: string, userId: string) {
  return db
    .select({ spaceId: projectSpaces.spaceId, agent: projectSpaces.dmAgentName, createdAt: projectSpaces.createdAt })
    .from(projectSpaces)
    .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.kind, 'dm'), eq(projectSpaces.dmUserId, userId)));
}

/** The layer of a route key; 404 for anything the viewer may not read. */
export async function resolveLayer(project: Project, key: string, viewer: Viewer): Promise<Layer> {
  if (key !== 'company' && !isUuid(key)) throw notFound();
  const { drive, caller } = await driveCallerOf(project, viewer);
  const base = { key, projectId: project.projectId, drive, agentFolder: null as string | null, skip: [] as string[], isDefault: false };
  let layer: Omit<Layer, 'canWrite'>;
  if (key === 'company') {
    layer = { ...base, scope: 'company', spaceId: null, name: 'Company', root: COMPANY_MEMORY_DIR, readOnly: false };
  } else {
    const [space] = await db
      .select(SPACE_COLUMNS)
      .from(projectSpaces)
      .where(
        and(
          eq(projectSpaces.projectId, project.projectId),
          eq(projectSpaces.spaceId, key),
          or(eq(projectSpaces.kind, 'channel'), eq(projectSpaces.dmUserId, viewer.userId)),
        ),
      )
      .limit(1);
    if (!space) throw notFound();
    // Memory routes refuse session tokens (`withMemoryCaller`): the viewer is a person.
    if (space.visibility === 'private' && (await hiddenSpaceIds(project.projectId, viewer.userId, null)).has(key)) throw notFound();
    const readOnly = space.archivedAt !== null;
    if (space.kind === 'channel') {
      const folders = space.slug ? spaceDriveFolders('channel', space.slug, null, space.visibility === 'private' ? key : null) : null;
      if (!folders) throw notFound();
      layer = { ...base, scope: 'channel', spaceId: key, name: `#${space.slug}`, root: folders.memory, readOnly, isDefault: space.isDefault };
    } else {
      const personal = personalFolderFor(caller.grants, viewer.userId) ?? caller.personalFolder;
      const agent = space.dmAgentName ?? '';
      const others = (await dmAgentsOf(project.projectId, viewer.userId)).filter((dm) => dm.spaceId !== key && dm.agent);
      layer = {
        ...base,
        scope: 'dm',
        spaceId: key,
        name: agent || 'Direct message',
        root: `${personal}/${MEMORY_DIR_NAME}`,
        agentFolder: spaceDriveFolders('dm', agent, personal)?.memory ?? null,
        skip: others.flatMap((dm) => spaceDriveFolders('dm', dm.agent!, personal)?.memory ?? []),
        readOnly,
      };
    }
  }
  const access = folderAccess(layer.root, caller.grants, caller.subject);
  if (!folderAccessAtLeast(access, 'read')) throw notFound();
  return { ...layer, canWrite: !layer.readOnly && folderAccessAtLeast(access, 'write') };
}

/** The viewer's newest DM layer key, for a hit in their shared Memory folder; null without a DM. */
export async function newestDmKey(projectId: string, userId: string): Promise<string | null> {
  const dms = await dmAgentsOf(projectId, userId);
  return dms.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.spaceId ?? null;
}

/** 409 for a read-only layer, 403 without write access. */
export function assertWrites(layer: Layer): void {
  if (layer.readOnly) throw new MemoryError(409, 'layer_read_only', 'This channel is archived. Its memory is read-only.');
  if (!layer.canWrite) throw new MemoryError(403, 'forbidden', 'You can only read this memory.');
}

/** A person as memory files name them: the profile display name, never an email; "A member" when there is none. */
export async function authorName(userId: string): Promise<string> {
  // The app's `participantLabel` rule: the display name, else the email's local part (never the whole email).
  const who = (await resolveUserIdentities([userId])).get(userId);
  const name = who?.displayName?.trim();
  return (name && !name.includes('@') ? name : who?.email?.split('@')[0]?.trim()) || 'A member';
}

const LABEL_CHARS = 80;

/**
 * A thread's label: its first prompt on one line, at most 80 characters; "a
 * thread" when it has none. The caller checked the viewer may open it. A
 * thread of a private channel noted into any other layer is "a private
 * thread": its words never leave the channel (`targetSpaceId`: the layer's space, null for Company).
 */
export async function threadLabelOf(projectId: string, sessionId: string, targetSpaceId: string | null): Promise<string> {
  const [row] = await db
    .select({
      firstPrompt: sql<string | null>`${projectSessions.metadata}->>'first_prompt'`,
      spaceId: projectSessions.spaceId,
      visibility: projectSpaces.visibility,
    })
    .from(projectSessions)
    .leftJoin(projectSpaces, eq(projectSpaces.spaceId, projectSessions.spaceId))
    .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, sessionId)))
    .limit(1);
  if (row?.visibility === 'private' && row.spaceId !== targetSpaceId) return 'a private thread';
  const text = row?.firstPrompt?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return 'a thread';
  return text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1).trimEnd()}…` : text;
}
