import { useQuery } from '@tanstack/react-query';
import { backendApi } from '../core/http/api-client';

/**
 * The admin fleet view of projects: every project on the platform, across every
 * account, most-active first. Sibling of `useAdminAccounts` and backed by
 * `GET /v1/admin/api/projects` (apps/api/src/admin/index.ts).
 *
 * "Active" is session activity, not row mtime: `lastSessionAt` is the newest
 * session's `created_at`, and the default sort puts projects with no session at
 * the end rather than the front.
 */

/** One row of the admin projects list. */
export interface AdminProject {
  workspaceId: string;
  name: string;
  /** `kortix.project_status` — 'active' | 'archived'. */
  status: string | null;
  accountId: string;
  accountName: string | null;
  /** Owner (or first admin) of the owning account; null when none resolves. */
  ownerEmail: string | null;
  createdAt: string | null;
  sessionCount: number;
  /** Sessions in queued/branching/provisioning/running. */
  activeSessionCount: number;
  /** `created_at` of the newest session; null when the project never ran one. */
  lastSessionAt: string | null;
}

export interface AdminProjectsResponse {
  projects: AdminProject[];
  total: number;
  page: number;
  limit: number;
  error?: string;
}

/** `activity` sorts on `lastSessionAt`, nulls last in both directions. */
export type AdminProjectsSortBy = 'activity' | 'created' | 'sessions';
export type AdminProjectsSortDir = 'asc' | 'desc';

export interface AdminProjectsFilters {
  /** Matches project name, account name, or any account member's email. */
  search?: string;
  accountId?: string;
  /** `kortix.project_status` values; empty = no status filter. */
  status?: string[];
  sortBy?: AdminProjectsSortBy;
  sortDir?: AdminProjectsSortDir;
  page?: number;
  /** Server caps this at 100. */
  limit?: number;
}

export function useAdminProjects(filters: AdminProjectsFilters = {}) {
  const {
    search = '',
    accountId = '',
    status = [],
    sortBy = 'activity',
    sortDir = 'desc',
    page = 1,
    limit = 50,
  } = filters;

  return useQuery<AdminProjectsResponse>({
    queryKey: ['admin', 'projects', search, accountId, status.join(','), sortBy, sortDir, page, limit],
    queryFn: async () => {
      const q = new URLSearchParams();
      if (search) q.set('search', search);
      if (accountId) q.set('accountId', accountId);
      if (status.length) q.set('status', status.join(','));
      q.set('sortBy', sortBy);
      q.set('sortDir', sortDir);
      q.set('page', String(page));
      q.set('limit', String(limit));
      const response = await backendApi.get<AdminProjectsResponse>(
        `/admin/api/projects?${q.toString()}`,
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}
