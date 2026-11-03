// Search a project's Files through the index (`GET /v1/projects/:id/search`).
//
// The index holds the whole drive; who may read what is decided here, per
// request, by the folder rules:
// - a person (JWT, PAT) reads what `folderAccess` gives them on the drive,
//   with the subject the Files routes build (`driveSubjectFor`): their grants,
//   their teams', the project's, and the project admin's reach;
// - a session (its session-bound token) reads exactly the folders it may
//   mount (`planSessionDrives` with no slot limit): its agent's, the
//   project's, and in its person's own private session that person's. A
//   folder that did not fit in the session's mount slots is searchable too.
//   A project admin's reach never reaches a session.
// SQL narrows the rows to the folders the reader reaches (a superset), and
// every hit is checked again with the reader's exact rule before it is
// returned.

import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { FolderAccess } from '../folders';
import { type DriveRow, driveSubjectFor, planSessionDrives } from '../service';
import { type ParsedQuery, encodeCursor } from './query';
import { type SearchReader, personReader, sessionReader } from './readers';
import { type SearchScope, searchCandidates, searchSnippets } from './store';

export type { SearchReader };

/** The reader for a person on the project's drive (see `driveSubjectFor`). */
export async function personSearchReader(
  drive: DriveRow,
  userId: string,
  may: (action: 'session' | 'write') => Promise<boolean>,
  /** The agents the person may use: their Drives are searched too. */
  usableAgents?: () => Promise<readonly string[]>,
): Promise<SearchReader> {
  const caller = await driveSubjectFor(drive, userId, may, null, false, usableAgents);
  return personReader(caller.grants, caller.subject);
}

/** The reader for a session-bound credential: every folder the session may mount, past its slots too. None for an unknown session. */
export async function sessionSearchReader(input: { accountId: string; projectId: string; sessionId: string }): Promise<SearchReader> {
  const [session] = await db
    .select({ createdBy: projectSessions.createdBy, agentName: projectSessions.agentName })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, input.sessionId), eq(projectSessions.projectId, input.projectId)))
    .limit(1);
  if (!session) return sessionReader([]);
  const plan = await planSessionDrives({
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    bootingUserId: session.createdBy,
    agentName: session.agentName,
    slots: Number.MAX_SAFE_INTEGER,
  });
  return sessionReader(plan.mounts);
}

export interface SearchHit {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  snippet: string | null;
  mtime: string | null;
  size: number;
  access: Exclude<FolderAccess, 'none'>;
}

/** Ranked rows read per round; a round whose rows the reader may not see reads the next. */
const ROUND_ROWS = 100;
const MAX_ROUNDS = 5;

/**
 * One page of hits the reader may read. `offset` counts the ranked rows the
 * earlier pages consumed (the cursor). A page can hold fewer than `limit`
 * hits and still have a `nextCursor` when many rows in between were not the
 * reader's; `nextCursor` is null only when no ranked row is left.
 */
export async function searchDriveIndex(input: {
  driveId: string;
  query: ParsedQuery;
  under: string | null;
  limit: number;
  offset: number;
  reader: SearchReader;
}): Promise<{ hits: SearchHit[]; nextCursor: string | null }> {
  const { driveId, query, reader, limit } = input;
  if (reader.include && reader.include.length === 0) return { hits: [], nextCursor: null };
  const scope: SearchScope = { include: reader.include, exclude: reader.exclude, under: input.under };
  const found: Array<Omit<SearchHit, 'snippet'>> = [];
  let offset = input.offset;
  // True once the ranked rows after `offset` are all read: no next page.
  let done = false;
  for (let round = 0; round < MAX_ROUNDS && found.length < limit; round++) {
    const rows = await searchCandidates(driveId, query, scope, offset, ROUND_ROWS);
    let i = 0;
    for (; i < rows.length && found.length < limit; i++) {
      const row = rows[i]!;
      offset++;
      const access = reader.access(row.path);
      if (access === 'none') continue;
      found.push({ path: row.path, name: row.name, kind: row.kind, mtime: row.mtime?.toISOString() ?? null, size: row.size, access });
    }
    if (rows.length < ROUND_ROWS && i === rows.length) {
      done = true;
      break;
    }
  }
  const snippets = await searchSnippets(driveId, query, found.filter((h) => h.kind === 'file').map((h) => h.path));
  const hits = found.map((h) => ({ ...h, snippet: snippets.get(h.path) ?? null }));
  return { hits, nextCursor: done ? null : encodeCursor(offset) };
}
