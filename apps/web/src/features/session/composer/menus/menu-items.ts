import type { Agent, Session } from '@kortix/sdk/react';

import type { MentionKind } from '../types';

export interface MenuRow {
  index: number;
  kind: MentionKind;
  label: string;
  value: string;
  description?: string;
}

export interface MentionSection {
  kind: MentionKind;
  heading: string;
  items: MenuRow[];
}

export function formatRelativeTime(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

export interface BuildMentionSectionsInput {
  agents: Agent[];
  sessions: Session[];
  files: string[];
  query: string;
  currentSessionId: string | undefined;
  /** Injected so the test is deterministic. */
  now?: number;
}

const SESSION_LIMIT = 5;
const FILE_LIMIT = 20;

/**
 * A session also matches when the query hits a file path it changed
 * (`summary.diffs[].file`) — not just its title or id. This preserves a real
 * discovery path from the live implementation
 * (session-chat-input.tsx:669-684): typing `@auth.ts` surfaces past sessions
 * that touched `auth.ts` even when neither the title nor the id mentions it.
 */
function sessionMatchesQuery(session: Session, q: string): boolean {
  const title = (session.title || '').toLowerCase();
  if (title.includes(q)) return true;
  if (session.id.toLowerCase().includes(q)) return true;
  const diffs = session.summary?.diffs;
  if (Array.isArray(diffs)) {
    return diffs.some((d) => (d.file || '').toLowerCase().includes(q));
  }
  return false;
}

export function buildMentionSections({
  agents,
  sessions,
  files,
  query,
  currentSessionId,
  now = 0,
}: BuildMentionSectionsInput): MentionSection[] {
  const q = query.toLowerCase();
  let index = 0;
  const sections: MentionSection[] = [];

  // Deliberately no `hidden` / `mode` filter here — this mirrors
  // session-chat-input.tsx:665 (`agents.filter((a) => (a.name || '')
  // .toLowerCase().includes(q))`, nothing else). `primaryAgents`
  // (session-chat-input.tsx:312-314, `!a.hidden && a.mode !== 'subagent'`)
  // exists in the same component but feeds Tab-cycling and the toolbar's
  // `AgentSelector` only — never the `@` menu. So hidden agents and
  // subagents ARE listed here today, which is plausibly how you delegate to
  // a subagent by name. Changing that is a product decision for Jay, not
  // something to fold into this refactor — see the pinning test below.
  const agentRows: MenuRow[] = agents
    .filter((a) => (a.name || '').toLowerCase().includes(q))
    .map((a) => ({ index: index++, kind: 'agent' as const, label: a.name || '', value: a.name || '' }));
  if (agentRows.length) sections.push({ kind: 'agent', heading: 'Agents', items: agentRows });

  const sessionRows: MenuRow[] = sessions
    .filter((s) => !s.parentID && !s.time.archived && s.id !== currentSessionId)
    .filter((s) => sessionMatchesQuery(s, q))
    .slice(0, SESSION_LIMIT)
    .map((s) => {
      const ago = formatRelativeTime(s.time.updated, now);
      const count = s.summary?.files;
      return {
        index: index++,
        kind: 'session' as const,
        label: s.title || s.id,
        value: s.id,
        description: count ? `${ago} · ${count} file${count === 1 ? '' : 's'} changed` : ago,
      };
    });
  if (sessionRows.length) sections.push({ kind: 'session', heading: 'Sessions', items: sessionRows });

  const fileRows: MenuRow[] = files
    .filter((f) => q.length === 0 || f.toLowerCase().includes(q))
    .slice(0, FILE_LIMIT)
    .map((f) => ({ index: index++, kind: 'file' as const, label: f, value: f }));
  if (fileRows.length) sections.push({ kind: 'file', heading: 'Files', items: fileRows });

  return sections;
}
