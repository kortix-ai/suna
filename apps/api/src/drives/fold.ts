// Fold the earlier drives (personal, company, agent; one volume each) into
// each project's one drive, as folders with the same access.
//
//   personal (default)   -> /Users/<owner>/                 owner: manage (their own folder)
//   personal (other)     -> /Users/<owner>/<drive name>/
//   company              -> /Shared/<drive name>/            grants reproduced
//   agent (project, A)   -> /Agents/<A>/                     agent A: write, project: write
//
// Shares carry over as folder grants at the same level: a `user` share or
// grant -> that person; a `project` grant -> everyone in the project; an
// `agent` grant -> that agent (and the personal-drive "agent may write my whole
// drive" opt-in becomes a write grant on the owner's folder).
//
// Which projects get a copy:
//   personal  -> projects whose sessions mounted it; else the project the owner
//                last started a session in; else the account's oldest project;
//   company   -> projects it was granted to (project or agent grants); else
//                every project of the account;
//   agent     -> its own project.
//
// Safe to run again and again:
//   - a file already at the destination is never overwritten (counted as kept);
//   - grants are upserts on (principal, folder);
//   - a finished (source, project) pair writes a marker at
//     /.kortix-folded/<source drive id> in the project drive and is skipped next time.
// The source rows and volumes are left alone; `retire` (separate, explicit)
// deletes the rows of sources that every target finished, and the drives
// delete trigger queues their volumes for the cleanup worker.

import { logger } from '../lib/logger';
import { driveGrants, drives, projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import type { FolderLevel, FolderPrincipalType } from './folders';
import {
  type DriveRow,
  agentServiceAccountId,
  ensurePersonalFolder,
  ensureProjectDrive,
  openVolumeFor,
  setFolderGrant,
} from './service';
import {
  DriveStorageError,
  commitVolumeUpload,
  listVolumeFilesPage,
  planVolumeUpload,
  putVolumeUploadBlock,
  readVolumeFile,
  statVolumeFile,
  writeVolumeFile,
} from './volumes';
import { ensureAgentServiceAccount } from '../repositories/service-accounts';

export const FOLD_MARKER_DIR = '/.kortix-folded';
const SINGLE_PUT_MAX = 64 * 1024 * 1024;
const BLOCK_BYTES = 1024 * 1024;

/** The storage the job copies through. Tests pass an in-memory one. */
export interface FoldStorage {
  listFiles(volume: string): Promise<Array<{ path: string; size: number }>>;
  exists(volume: string, path: string): Promise<boolean>;
  read(volume: string, path: string, range?: { start: number; end: number }): Promise<Uint8Array<ArrayBuffer>>;
  write(volume: string, path: string, body: Uint8Array<ArrayBuffer>): Promise<void>;
  /** A file too large for one write: block by block, never all in memory. */
  writeLarge(volume: string, path: string, size: number, readBlock: (start: number, end: number) => Promise<Uint8Array<ArrayBuffer>>): Promise<void>;
  /** The target drive's volume name, opened (created) if needed. */
  open(drive: DriveRow): Promise<string>;
}

export const volumeFoldStorage: FoldStorage = {
  async listFiles(volume) {
    const out: Array<{ path: string; size: number }> = [];
    let cursor: string | undefined;
    do {
      const page = await listVolumeFilesPage(volume, '/', { recursive: true, ...(cursor ? { cursor } : {}) });
      for (const e of page.entries) if (e.type === 'file') out.push({ path: e.path, size: Number(e.size ?? 0) });
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return out;
  },
  async exists(volume, path) {
    try {
      await statVolumeFile(volume, path);
      return true;
    } catch (err) {
      if (err instanceof DriveStorageError && err.status === 404) return false;
      throw err;
    }
  },
  async read(volume, path, range) {
    const res = await readVolumeFile(volume, path, range ? `bytes=${range.start}-${range.end - 1}` : undefined);
    return new Uint8Array(await res.arrayBuffer());
  },
  async write(volume, path, body) {
    await writeVolumeFile(volume, path, body, { overwrite: false });
  },
  async writeLarge(volume, path, size, readBlock) {
    const { createHash } = await import('node:crypto');
    const blocks: string[] = [];
    for (let off = 0; off < size; off += BLOCK_BYTES) {
      blocks.push(createHash('sha256').update(await readBlock(off, Math.min(size, off + BLOCK_BYTES))).digest('hex'));
    }
    const plan = (await planVolumeUpload(volume, { files: [{ path, size, blocks }], overwrite: false })) as {
      upload_id: string;
      missing?: string[];
    };
    const missing = new Set(plan.missing ?? []);
    for (let i = 0; i < blocks.length; i++) {
      const sha = blocks[i]!;
      if (!missing.delete(sha)) continue;
      const off = i * BLOCK_BYTES;
      await putVolumeUploadBlock(volume, plan.upload_id, sha, await readBlock(off, Math.min(size, off + BLOCK_BYTES)));
    }
    await commitVolumeUpload(volume, plan.upload_id);
  },
  open: (drive) => openVolumeFor(drive),
};

export interface FoldTarget {
  projectId: string;
  /** The folder in the project drive the source's files land in. */
  path: string;
  grants: Array<{ principal: { type: FolderPrincipalType; id: string }; level: FolderLevel }>;
}

export interface FoldReport {
  source: string;
  kind: string;
  projectId: string;
  path: string;
  copied: number;
  kept: number;
  grants: number;
  skipped?: 'already_folded' | 'no_project';
}

const level = (access: string): FolderLevel => (access === 'read' ? 'read' : 'write');

/** A file or folder name that is safe as one path segment. */
function segment(name: string): string {
  const clean = name.replace(/[/\\\0]/g, '-').replace(/^\.+/, '').trim().slice(0, 80);
  return clean || 'drive';
}

/** The projects a source drive folds into, and the folder and grants in each. */
export async function foldTargets(source: DriveRow): Promise<FoldTarget[]> {
  const grants = await db.select().from(driveGrants).where(eq(driveGrants.driveId, source.driveId)).orderBy(asc(driveGrants.createdAt));
  const accountProjects = await db
    .select({ projectId: projects.projectId })
    .from(projects)
    .where(eq(projects.accountId, source.accountId))
    .orderBy(asc(projects.createdAt));
  const inAccount = new Set(accountProjects.map((p) => p.projectId));

  if (source.kind === 'agent') {
    if (!source.projectId || !source.agentName) return [];
    return [
      {
        projectId: source.projectId,
        path: `/Agents/${segment(source.agentName)}`,
        grants: [
          { principal: { type: 'agent', id: source.agentName }, level: 'write' },
          { principal: { type: 'project', id: source.projectId }, level: 'write' },
        ],
      },
    ];
  }

  if (source.kind === 'company') {
    const granted = [...new Set(grants.map((g) => g.projectId).filter((p): p is string => !!p && inAccount.has(p)))];
    const targetProjects = granted.length ? granted : accountProjects.map((p) => p.projectId);
    return targetProjects.map((projectId) => ({
      projectId,
      path: `/Shared/${segment(source.name)}`,
      grants: grants.flatMap<FoldTarget['grants'][number]>((g) => {
        if (g.subjectType === 'user' && g.userId) return [{ principal: { type: 'user' as const, id: g.userId }, level: level(g.access) }];
        if (g.subjectType === 'project' && g.projectId === projectId) {
          return [{ principal: { type: 'project' as const, id: projectId }, level: level(g.access) }];
        }
        if (g.subjectType === 'agent' && g.projectId === projectId && g.agentName) {
          return [{ principal: { type: 'agent' as const, id: g.agentName }, level: level(g.access) }];
        }
        return [];
      }),
    }));
  }

  if (source.kind !== 'personal' || !source.ownerUserId) return [];
  const owner = source.ownerUserId;
  const mounted = (await db
    .selectDistinct({ projectId: projectSessions.projectId })
    .from(sessionSandboxes)
    .innerJoin(projectSessions, eq(projectSessions.sessionId, sessionSandboxes.sessionId))
    .where(
      and(
        eq(projectSessions.accountId, source.accountId),
        sql`${sessionSandboxes.metadata} -> 'driveMounts' @> ${JSON.stringify([{ driveId: source.driveId }])}::jsonb`,
      ),
    )).map((r) => r.projectId);
  let targetProjects = mounted.filter((p) => inAccount.has(p));
  if (!targetProjects.length) {
    const [last] = await db
      .select({ projectId: projectSessions.projectId })
      .from(projectSessions)
      .where(and(eq(projectSessions.accountId, source.accountId), eq(projectSessions.createdBy, owner)))
      .orderBy(desc(projectSessions.createdAt))
      .limit(1);
    targetProjects = last ? [last.projectId] : accountProjects.slice(0, 1).map((p) => p.projectId);
  }
  return targetProjects.map((projectId) => ({
    projectId,
    // Resolved against the project drive when it runs: `/Users/<owner folder>`.
    path: source.isDefault ? '' : segment(source.name),
    grants: grants.flatMap<FoldTarget['grants'][number]>((g) => {
      if (g.subjectType === 'user' && g.userId && g.userId !== owner) {
        return [{ principal: { type: 'user' as const, id: g.userId }, level: level(g.access) }];
      }
      if (g.subjectType === 'agent' && g.projectId === projectId && g.agentName && g.access === 'write') {
        return [{ principal: { type: 'agent' as const, id: g.agentName }, level: 'write' as const }];
      }
      return [];
    }),
  }));
}

/** Fold one source drive into every project it belongs to. */
export async function foldDrive(source: DriveRow, storage: FoldStorage = volumeFoldStorage): Promise<FoldReport[]> {
  const out: FoldReport[] = [];
  const targets = await foldTargets(source);
  if (!targets.length) {
    return [{ source: source.driveId, kind: source.kind, projectId: '', path: '', copied: 0, kept: 0, grants: 0, skipped: 'no_project' }];
  }
  for (const target of targets) {
    const drive = await ensureProjectDrive(source.accountId, target.projectId);
    let path = target.path;
    if (source.kind === 'personal') {
      const own = await ensurePersonalFolder(drive, source.ownerUserId!);
      path = path ? `${own}/${path}` : own;
    }
    const report: FoldReport = { source: source.driveId, kind: source.kind, projectId: target.projectId, path, copied: 0, kept: 0, grants: 0 };
    const dest = await storage.open(drive);
    const marker = `${FOLD_MARKER_DIR}/${source.driveId}`;
    if (await storage.exists(dest, marker)) {
      out.push({ ...report, skipped: 'already_folded' });
      continue;
    }
    for (const g of target.grants) {
      let id = g.principal.id;
      if (g.principal.type === 'agent') {
        id =
          (await agentServiceAccountId(source.accountId, target.projectId, id)) ??
          (await ensureAgentServiceAccount({ accountId: source.accountId, projectId: target.projectId, agentName: id }));
      }
      await setFolderGrant({ drive, path, principal: { type: g.principal.type, id }, level: g.level, grantedBy: null, source: 'manual' });
      report.grants++;
    }
    if (source.platinumVolumeId) {
      const from = source.platinumVolumeName;
      for (const file of await storage.listFiles(from)) {
        const to = `${path}${file.path}`;
        if (await storage.exists(dest, to)) {
          report.kept++;
          continue;
        }
        if (file.size <= SINGLE_PUT_MAX) {
          await storage.write(dest, to, await storage.read(from, file.path));
        } else {
          await storage.writeLarge(dest, to, file.size, (start, end) => storage.read(from, file.path, { start, end }));
        }
        report.copied++;
      }
    }
    await storage.write(
      dest,
      marker,
      new TextEncoder().encode(JSON.stringify({ source: source.driveId, kind: source.kind, path, at: new Date().toISOString() })) as Uint8Array<ArrayBuffer>,
    );
    out.push(report);
  }
  return out;
}

/** Fold every earlier drive, of one account or of all. */
export async function foldAll(opts: { accountId?: string; storage?: FoldStorage; log?: (r: FoldReport) => void } = {}): Promise<FoldReport[]> {
  const sources = await db
    .select()
    .from(drives)
    .where(
      and(
        inArray(drives.kind, ['personal', 'company', 'agent']),
        opts.accountId ? eq(drives.accountId, opts.accountId) : undefined,
      ),
    )
    .orderBy(asc(drives.createdAt));
  const out: FoldReport[] = [];
  for (const source of sources) {
    try {
      for (const r of await foldDrive(source, opts.storage)) {
        out.push(r);
        opts.log?.(r);
      }
    } catch (err) {
      logger.error(`[drives] folding drive ${source.driveId} (${source.kind}) failed; run again to resume:`, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * Delete the rows of sources every target of which finished (its marker is in
 * each target project drive). The drives delete trigger queues each volume for
 * the cleanup worker. Only on an operator's explicit request.
 */
export async function retireFolded(opts: { accountId?: string; storage?: FoldStorage } = {}): Promise<string[]> {
  const storage = opts.storage ?? volumeFoldStorage;
  const sources = await db
    .select()
    .from(drives)
    .where(and(inArray(drives.kind, ['personal', 'company', 'agent']), opts.accountId ? eq(drives.accountId, opts.accountId) : undefined));
  const retired: string[] = [];
  for (const source of sources) {
    const targets = await foldTargets(source);
    if (!targets.length) continue;
    let done = true;
    for (const t of targets) {
      const drive = await ensureProjectDrive(source.accountId, t.projectId);
      if (!drive.platinumVolumeId || !(await storage.exists(drive.platinumVolumeName, `${FOLD_MARKER_DIR}/${source.driveId}`))) {
        done = false;
        break;
      }
    }
    if (!done) continue;
    await db.delete(drives).where(eq(drives.driveId, source.driveId));
    retired.push(source.driveId);
  }
  return retired;
}
