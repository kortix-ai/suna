/**
 * The memory layers of one thread, read in one query: the thread's root
 * session (a subagent resolves through its root), its space, and the layers.
 *
 * | Thread                      | Writes (`remember`)  | Reads                              |
 * |-----------------------------|----------------------|------------------------------------|
 * | channel                     | channel (default), company | company, channel              |
 * | private channel thread (D3) | channel, company     | company, channel, the owner's DM with the thread's agent |
 * | DM                          | dm (default), company | company, dm                       |
 * | no space                    | nothing              | nothing (null)                     |
 */
import type { MemoryLayerScope } from '@kortix/api-contract';
import { sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { db } from '../shared/db';
import { ensureLayerRow, layerRef, type LayerRef, type SpaceInfo } from './layers';

/** One row of the thread query. */
export interface ThreadRow {
  project_id: string;
  project_metadata: unknown;
  /** The calling session (a subagent's own agent and owner). */
  session_agent: string;
  session_created_by: string | null;
  root_session_id: string;
  root_visibility: string;
  root_created_by: string | null;
  space_id: string | null;
  space_kind: 'channel' | 'dm' | null;
  space_slug: string | null;
  space_dm_user_id: string | null;
  space_dm_agent: string | null;
  space_archived_at: string | Date | null;
  /** D3: the root owner's live DM with the root's agent, for a private channel thread. */
  dm_space_id: string | null;
  dm_user_id: string | null;
  dm_agent: string | null;
  layers: { layer_id: string; scope: MemoryLayerScope; space_id: string | null; version: string }[] | null;
  /** The calling session already has its "Used memory" record (`memory_thread_loads`). */
  loaded?: boolean;
}

export interface PlannedLayer {
  scope: MemoryLayerScope;
  spaceId: string | null;
  space: SpaceInfo | null;
}

/** Which layers a thread reads, and its own layer (pure). Null for a thread in no space. */
export function threadPlan(row: ThreadRow): { own: PlannedLayer; read: PlannedLayer[] } | null {
  if (!row.space_id || !row.space_kind) return null;
  const own: PlannedLayer = {
    scope: row.space_kind,
    spaceId: row.space_id,
    space: {
      kind: row.space_kind,
      slug: row.space_slug,
      dmUserId: row.space_dm_user_id,
      dmAgentName: row.space_dm_agent,
      archivedAt: row.space_archived_at ? new Date(row.space_archived_at) : null,
    },
  };
  const read: PlannedLayer[] = [{ scope: 'company', spaceId: null, space: null }, own];
  if (row.space_kind === 'channel' && row.root_visibility === 'private' && row.dm_space_id) {
    read.push({
      scope: 'dm',
      spaceId: row.dm_space_id,
      space: { kind: 'dm', slug: null, dmUserId: row.dm_user_id, dmAgentName: row.dm_agent, archivedAt: null },
    });
  }
  return { own, read };
}

export interface ThreadLayers {
  sessionId: string;
  /** The thread itself: the root session (a subagent's thread is its root's). Sources and versions name it. */
  threadSessionId: string;
  /** The thread's sharing and owner: which other threads its agent may cite by name (`threadGate`). */
  threadVisibility: string;
  threadOwner: string | null;
  projectId: string;
  projectMetadata: unknown;
  /** The calling session's agent and owner: the author of its `remember` writes. */
  agentName: string;
  createdBy: string | null;
  /** The channel or DM layer: `remember`'s default. */
  own: LayerRef;
  company: LayerRef;
  /** Company first, then the thread's own layer, then (D3) the personal layer. */
  read: LayerRef[];
  /** The calling session already has its "Used memory" record. */
  loaded: boolean;
}

const MAX_DEPTH = 20;

async function readThreadRow(sessionId: string): Promise<ThreadRow | null> {
  const rows = (await db.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT session_id, parent_session_id, project_id, space_id, created_by, agent_name, visibility::text AS visibility, 0 AS depth
        FROM kortix.project_sessions WHERE session_id = ${sessionId}
      UNION ALL
      SELECT p.session_id, p.parent_session_id, p.project_id, p.space_id, p.created_by, p.agent_name, p.visibility::text, c.depth + 1
        FROM kortix.project_sessions p JOIN chain c ON p.session_id = c.parent_session_id
       WHERE c.depth < ${MAX_DEPTH} AND p.project_id = c.project_id
    ),
    self AS (SELECT * FROM chain WHERE depth = 0),
    root AS (SELECT * FROM chain ORDER BY depth DESC LIMIT 1)
    SELECT r.project_id, pr.metadata AS project_metadata,
           self.agent_name AS session_agent, self.created_by AS session_created_by,
           r.session_id AS root_session_id, r.visibility AS root_visibility, r.created_by AS root_created_by,
           s.space_id, s.kind::text AS space_kind, s.slug AS space_slug, s.dm_user_id AS space_dm_user_id,
           s.dm_agent_name AS space_dm_agent, s.archived_at AS space_archived_at,
           dm.space_id AS dm_space_id, dm.dm_user_id, dm.dm_agent_name AS dm_agent,
           EXISTS (SELECT 1 FROM kortix.memory_thread_loads tl WHERE tl.session_id = ${sessionId}) AS loaded,
           (SELECT jsonb_agg(jsonb_build_object('layer_id', l.layer_id, 'scope', l.scope, 'space_id', l.space_id, 'version', l.version::text))
              FROM kortix.memory_layers l
             WHERE l.project_id = r.project_id
               AND (l.scope = 'company' OR l.space_id = s.space_id OR l.space_id = dm.space_id)) AS layers
      FROM root r
      CROSS JOIN self
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

/**
 * The layers of the thread `sessionId`; null when the session is unknown, in
 * no space, or its project has `project_channels` off. Layers a thread reads for the first time are made here.
 */
export async function threadLayers(sessionId: string): Promise<ThreadLayers | null> {
  const row = await readThreadRow(sessionId);
  if (!row) return null;
  const plan = threadPlan(row);
  if (!plan || !resolveFeatureFlag(row.project_metadata, 'project_channels')) return null;
  const project = { projectId: row.project_id, metadata: row.project_metadata };
  const read = await Promise.all(
    plan.read.map(async (layer) => {
      const existing = row.layers?.find((l) => (layer.spaceId === null ? l.scope === 'company' : l.space_id === layer.spaceId));
      const layerRow = existing
        ? {
            layerId: existing.layer_id,
            projectId: row.project_id,
            scope: existing.scope,
            spaceId: existing.space_id,
            version: Number(existing.version),
            importedAt: null,
            createdAt: new Date(0),
          }
        : await ensureLayerRow(project, layer.scope, layer.spaceId);
      return layerRef(layerRow, layer.space);
    }),
  );
  return {
    sessionId,
    threadSessionId: row.root_session_id,
    threadVisibility: row.root_visibility,
    threadOwner: row.root_created_by,
    projectId: row.project_id,
    projectMetadata: row.project_metadata,
    agentName: row.session_agent,
    createdBy: row.session_created_by,
    own: read[1]!,
    company: read[0]!,
    read,
    loaded: row.loaded === true,
  };
}
