// "## Where you are": the first block of every session turn's `system` text
// (sandbox-proxy/forward/turn-start.ts). It names the space the session is
// filed in, the surface it was started from, the person who started it and
// its parent session, so an agent always knows where it was launched from.
// One DB read per turn start; no box call.
import { isMyKortixAgentName } from '@kortix/shared';
import { sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { memberDisplayName } from './project-space-members';

/** The origin block stays short: it is never cut, so it bounds what the memory list may use. */
export const SESSION_WHERE_MAX_CHARS = 600;

/** The session row and what it points at, as the one read returns it. */
export interface SessionWhereRow {
  space_id: string | null;
  space_kind: 'channel' | 'dm' | null;
  space_slug: string | null;
  space_name: string | null;
  space_dm_agent: string | null;
  /** `metadata.source`: web, cli, mobile, trigger:<slug>, system:chat-post, agent, … */
  source: string | null;
  /** `metadata.trigger_slug`: the trigger that started the session, when one did. */
  trigger_slug: string | null;
  person_name: string | null;
  person_full_name: string | null;
  person_email: string | null;
  parent_session_id: string | null;
  parent_title: string | null;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const SURFACES: Record<string, string> = {
  ui: 'the web app',
  web: 'the web app',
  mobile: 'the mobile app',
  cli: 'the CLI',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  telegram: 'Telegram',
  discord: 'Discord',
  email: 'email',
  agent: 'another session',
};

/**
 * `metadata.source` in words: `trigger:cron` → "a scheduled trigger (<slug>)",
 * `system:chat-post` → Kortix itself. Null for a source this list does not
 * know, so the block leaves the line out instead of printing a raw code.
 */
export function sessionSourceText(source: string | null, triggerSlug: string | null): string | null {
  if (!source) return null;
  if (source.startsWith('trigger:')) {
    const kind = source.slice('trigger:'.length);
    const slug = triggerSlug ? ` (${oneLine(triggerSlug, 60)})` : '';
    return kind ? `a ${kind === 'cron' ? 'scheduled' : oneLine(kind, 30)} trigger${slug}` : `a trigger${slug}`;
  }
  if (source === 'system:chat-post') return 'Kortix (it started this thread itself)';
  if (source === 'system:space-watcher') return 'Kortix, watching this space for the person it works for';
  if (source === 'system:goal') return 'Kortix, working a goal for the person it belongs to';
  if (source === 'system' || source.startsWith('system:')) return 'Kortix (system)';
  // Channel sources carry their bot or inbox after a colon: `telegram:<bot>`, `email:<inbox>`.
  return SURFACES[source.split(':')[0]] ?? null;
}

/**
 * A `dm` space as people see it (flag `chat`): the person's personal space
 * when its agent is My Kortix, else their private space with that agent.
 * Agents say "space", never "direct message".
 */
export function privateSpaceText(agentName: string): string {
  return isMyKortixAgentName(agentName)
    ? "the person's personal space (private: only they and you)"
    : `the person's private space with ${oneLine(agentName, 40)}`;
}

/**
 * The block's text (pure). Member-written values (names, titles) are one line
 * each, so none can start a heading, and the space name and parent title are
 * JSON-quoted, so none can close its quote and read as a directive. The person is named by display name,
 * never by email (`memberDisplayName` keeps only the part before `@`).
 */
export function sessionWhereText(row: SessionWhereRow): string {
  const space =
    row.space_id && row.space_kind === 'channel'
      ? `#${oneLine(row.space_slug ?? row.space_name ?? '', 40)}${row.space_name && row.space_name !== row.space_slug ? ` (${JSON.stringify(oneLine(row.space_name, 60))})` : ''}, space ${row.space_id}`
      : row.space_id && row.space_kind === 'dm'
        ? `${privateSpaceText(row.space_dm_agent ?? row.space_name ?? 'an agent')}, space ${row.space_id}`
        : null;
  const name = row.person_name || row.person_full_name || row.person_email ? memberDisplayName({ displayName: row.person_name ?? row.person_full_name, email: row.person_email }) : '';
  const from = sessionSourceText(row.source, row.trigger_slug);
  const lines = [
    '## Where you are',
    ...(space ? [`- Space: ${space}`] : []),
    ...(from ? [`- Started from: ${from}`] : []),
    `- Started by: ${name ? oneLine(name, 60) : 'no person (an automation)'}`,
    ...(row.parent_session_id ? [`- Parent session: ${JSON.stringify(oneLine(row.parent_title || 'Untitled', 80))}, id ${row.parent_session_id}`] : []),
  ];
  return lines.join('\n').slice(0, SESSION_WHERE_MAX_CHARS);
}

/**
 * One read: the session, its space, its parent session and the person who
 * started it. Null when the session is not in this project.
 */
export async function readSessionWhere(projectId: string, sessionId: string): Promise<SessionWhereRow | null> {
  const rows = (await db.execute(sql`
    SELECT s.space_id,
           sp.kind::text AS space_kind, sp.slug AS space_slug, sp.name AS space_name, sp.dm_agent_name AS space_dm_agent,
           s.metadata->>'source' AS source,
           s.metadata->>'trigger_slug' AS trigger_slug,
           u.raw_user_meta_data->>'name' AS person_name,
           u.raw_user_meta_data->>'full_name' AS person_full_name,
           u.email AS person_email,
           p.session_id AS parent_session_id,
           coalesce(nullif(p.metadata->>'custom_name', ''), nullif(p.metadata->>'name', ''), nullif(p.metadata->>'chat_root_text', '')) AS parent_title
      FROM kortix.project_sessions s
      LEFT JOIN kortix.project_spaces sp ON sp.space_id = s.space_id AND sp.project_id = s.project_id
      LEFT JOIN kortix.project_sessions p
        ON p.project_id = s.project_id
       AND p.session_id = coalesce(s.parent_session_id, s.metadata->>'spawned_by_session')
      LEFT JOIN auth.users u ON u.id = s.created_by
     WHERE s.session_id = ${sessionId} AND s.project_id = ${projectId}
     LIMIT 1
  `)) as unknown as SessionWhereRow[];
  return rows[0] ?? null;
}

/** The block for a session's turn, with the space it is filed in (for the memory choice). Null when the session is not found. */
export async function sessionWhereTurn(
  projectId: string,
  sessionId: string,
): Promise<{ system: string; space: { kind: 'channel' | 'dm'; dmAgent: string | null } | null } | null> {
  const row = await readSessionWhere(projectId, sessionId);
  if (!row) return null;
  return {
    system: sessionWhereText(row),
    space: row.space_id && row.space_kind ? { kind: row.space_kind, dmAgent: row.space_dm_agent } : null,
  };
}
