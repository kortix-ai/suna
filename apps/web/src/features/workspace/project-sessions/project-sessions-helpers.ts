import type { ProjectSession } from '@kortix/sdk/projects-client';

import { sessionSource } from '@/components/projects/session-label';
import { getSessionDisplayTitle } from '@/features/workspace/project-sidebar/project-session-list-helpers';

export type ProjectSessionsFilter =
  | 'all'
  | 'active'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'automated'
  | 'shared'
  | 'deleted'
  | 'inaccessible';

export const PROJECT_SESSIONS_FILTERS: Array<{
  value: ProjectSessionsFilter;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'failed', label: 'Failed' },
  { value: 'automated', label: 'Automated' },
  { value: 'shared', label: 'Shared' },
  { value: 'deleted', label: 'Deleted' },
  { value: 'inaccessible', label: 'Metadata only' },
];

const ACTIVE_STATUSES = new Set<ProjectSession['status']>([
  'queued',
  'branching',
  'provisioning',
  'running',
]);

export function matchesProjectSessionsFilter(
  session: ProjectSession,
  filter: ProjectSessionsFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return ACTIVE_STATUSES.has(session.status);
  if (filter === 'automated') return sessionSource(session).kind !== 'chat';
  if (filter === 'shared') return session.is_owner === false;
  if (filter === 'deleted') return Boolean(session.deleted_at);
  if (filter === 'inaccessible') return session.can_access === false;
  return session.status === filter;
}

export function sessionOwnerLabel(session: ProjectSession): string {
  if (session.owner_name) return session.owner_name;
  if (session.owner_email) return session.owner_email;
  if (session.is_owner === true) return 'You';
  return 'Unknown owner';
}

export function sessionAccessMeta(session: ProjectSession): {
  label: 'Can open' | 'Metadata only' | 'Runtime unavailable' | 'Deleted';
  canOpen: boolean;
} {
  if (session.deleted_at) return { label: 'Deleted', canOpen: false };
  if (session.can_access === false) return { label: 'Metadata only', canOpen: false };
  if (session.status === 'stopped' && !session.runtime_status) {
    return { label: 'Runtime unavailable', canOpen: false };
  }
  if (session.runtime_status === 'archived' || session.runtime_status === 'error') {
    return { label: 'Runtime unavailable', canOpen: false };
  }
  return { label: 'Can open', canOpen: true };
}

export function sessionSearchText(session: ProjectSession): string {
  const source = sessionSource(session);
  return [
    getSessionDisplayTitle(session),
    session.session_id,
    session.branch_name,
    session.base_ref,
    session.agent_name,
    session.owner_email,
    session.owner_name,
    session.owner_type,
    session.sandbox_provider,
    session.status,
    session.visibility,
    session.runtime_status,
    session.deleted_at,
    source.label,
    source.triggerSlug,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLocaleLowerCase();
}

export function filterProjectSessions(
  sessions: ProjectSession[],
  filter: ProjectSessionsFilter,
  query: string,
): ProjectSession[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return sessions
    .filter((session) => matchesProjectSessionsFilter(session, filter))
    .filter((session) => !normalizedQuery || sessionSearchText(session).includes(normalizedQuery))
    .sort((a, b) => {
      const parsedA = new Date(a.updated_at || a.created_at).getTime();
      const parsedB = new Date(b.updated_at || b.created_at).getTime();
      const aTime = Number.isFinite(parsedA) ? parsedA : 0;
      const bTime = Number.isFinite(parsedB) ? parsedB : 0;
      return bTime - aTime;
    });
}

export function projectSessionsFilterCounts(
  sessions: ProjectSession[],
): Record<ProjectSessionsFilter, number> {
  return PROJECT_SESSIONS_FILTERS.reduce(
    (counts, option) => {
      counts[option.value] = sessions.filter((session) =>
        matchesProjectSessionsFilter(session, option.value),
      ).length;
      return counts;
    },
    {} as Record<ProjectSessionsFilter, number>,
  );
}
