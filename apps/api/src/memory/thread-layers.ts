/**
 * The memory layers one thread reads, as Drive folders, from one query: the
 * thread's root session (a subagent resolves through its root), its space,
 * and (for a private channel thread) its owner's DM with the thread's agent.
 *
 * | Thread                       | Reads                                        |
 * |------------------------------|----------------------------------------------|
 * | channel                      | Company, the channel                         |
 * | private channel thread  | Company, the channel, the owner's DM layer   |
 * | DM                           | Company, the DM layer                        |
 * | no space                     | nothing (null)                               |
 */
import type { MemoryLayerScope } from '@kortix/api-contract';
import { spaceDriveFolders } from '@kortix/shared';
import { sql } from 'drizzle-orm';
import { COMPANY_MEMORY_DIR, MEMORY_DIR_NAME } from '../drives/folders';
import { db } from '../shared/db';

/** One row of the thread query. */
export interface ThreadRow {
  project_id: string;
  project_metadata: unknown;
  root_session_id: string;
  root_visibility: string;
  root_created_by: string | null;
  space_id: string | null;
  space_kind: 'channel' | 'dm' | null;
  space_slug: string | null;
  /** A channel's visibility: a private channel's memory is `/Channels/<slug>/Memory`. */
  space_visibility?: 'public' | 'private' | null;
  space_dm_user_id: string | null;
  space_dm_agent: string | null;
  /** the root owner's live DM with the root's agent, for a private channel thread. */
  dm_space_id: string | null;
  dm_user_id: string | null;
  dm_agent: string | null;
  /** The calling session already has its "Used memory" record (`memory_thread_loads`). */
  loaded?: boolean;
}

/** A layer a thread reads, before its person's folder is known. */
export interface PlannedLayer {
  key: string;
  scope: MemoryLayerScope;
  /** "Company", "#marketing", or the DM's agent. */
  name: string;
  /** The channel slug; null for others. */
  slug: string | null;
  /** The channel's visibility; undefined reads as public. */
  visibility?: 'public' | 'private';
  /** The DM owner and agent; null for others. */
  dmUserId: string | null;
  dmAgent: string | null;
}

/** Which layers a thread reads (pure): Company first, then its own, then the owner's DM. Null for a thread in no space. */
export function threadPlan(row: ThreadRow): PlannedLayer[] | null {
  if (!row.space_id || !row.space_kind) return null;
  const company: PlannedLayer = { key: 'company', scope: 'company', name: 'Company', slug: null, dmUserId: null, dmAgent: null };
  const own: PlannedLayer =
    row.space_kind === 'channel'
      ? {
          key: row.space_id,
          scope: 'channel',
          name: `#${row.space_slug}`,
          slug: row.space_slug,
          visibility: row.space_visibility === 'private' ? 'private' : 'public',
          dmUserId: null,
          dmAgent: null,
        }
      : { key: row.space_id, scope: 'dm', name: row.space_dm_agent ?? 'Direct message', slug: null, dmUserId: row.space_dm_user_id, dmAgent: row.space_dm_agent };
  const read = [company, own];
  if (row.space_kind === 'channel' && row.root_visibility === 'private' && row.dm_space_id) {
    read.push({ key: row.dm_space_id, scope: 'dm', name: row.dm_agent ?? 'Direct message', slug: null, dmUserId: row.dm_user_id, dmAgent: row.dm_agent });
  }
  return read;
}

/** A planned layer's folder, its DM agent folder, given the DM owner's own folder; null when it has none. */
export function layerFolders(layer: PlannedLayer, personalFolder: string | null): { root: string; agentFolder: string | null } | null {
  if (layer.scope === 'company') return { root: COMPANY_MEMORY_DIR, agentFolder: null };
  if (layer.scope === 'channel') {
    const folders = layer.slug ? spaceDriveFolders('channel', layer.slug, null, layer.visibility === 'private' ? layer.key : null) : null;
    return folders ? { root: folders.memory, agentFolder: null } : null;
  }
  if (!personalFolder) return null;
  return { root: `${personalFolder}/${MEMORY_DIR_NAME}`, agentFolder: layer.dmAgent ? (spaceDriveFolders('dm', layer.dmAgent, personalFolder)?.memory ?? null) : null };
}

const MAX_DEPTH = 20;

export async function readThreadRow(sessionId: string): Promise<ThreadRow | null> {
  const rows = (await db.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT session_id, parent_session_id, project_id, space_id, created_by, agent_name, visibility::text AS visibility, 0 AS depth
        FROM kortix.project_sessions WHERE session_id = ${sessionId}
      UNION ALL
      SELECT p.session_id, p.parent_session_id, p.project_id, p.space_id, p.created_by, p.agent_name, p.visibility::text, c.depth + 1
        FROM kortix.project_sessions p JOIN chain c ON p.session_id = c.parent_session_id
       WHERE c.depth < ${MAX_DEPTH} AND p.project_id = c.project_id
    ),
    root AS (SELECT * FROM chain ORDER BY depth DESC LIMIT 1)
    SELECT r.project_id, pr.metadata AS project_metadata,
           r.session_id AS root_session_id, r.visibility AS root_visibility, r.created_by AS root_created_by,
           s.space_id, s.kind::text AS space_kind, s.slug AS space_slug, s.visibility::text AS space_visibility,
           s.dm_user_id AS space_dm_user_id,
           s.dm_agent_name AS space_dm_agent,
           dm.space_id AS dm_space_id, dm.dm_user_id, dm.dm_agent_name AS dm_agent,
           EXISTS (SELECT 1 FROM kortix.memory_thread_loads tl WHERE tl.session_id = ${sessionId}) AS loaded
      FROM root r
      JOIN kortix.projects pr ON pr.project_id = r.project_id
      LEFT JOIN kortix.project_spaces s ON s.space_id = r.space_id AND s.project_id = r.project_id
      LEFT JOIN LATERAL (
        SELECT d.space_id, d.dm_user_id, d.dm_agent_name FROM kortix.project_spaces d
         WHERE s.kind = 'channel' AND r.visibility = 'private'
           AND d.project_id = r.project_id AND d.kind = 'dm' AND d.archived_at IS NULL
           AND d.dm_user_id = r.created_by AND d.dm_agent_name = r.agent_name
         LIMIT 1
      ) dm ON true
  `)) as unknown as ThreadRow[];
  return rows[0] ?? null;
}
