import { useQuery } from "@tanstack/react-query";

import { backendApi } from "../core/http/api-client";

/** One row in the platform-wide admin Workspace list. */
export interface AdminWorkspace {
  workspaceId: string;
  name: string;
  /** Physical `kortix.project_status`: `active` or `archived`. */
  status: string | null;
  accountId: string;
  accountName: string | null;
  ownerEmail: string | null;
  createdAt: string | null;
  sessionCount: number;
  activeSessionCount: number;
  lastSessionAt: string | null;
}

export interface AdminWorkspacesResponse {
  workspaces: AdminWorkspace[];
  total: number;
  page: number;
  limit: number;
  error?: string;
}

export type AdminWorkspacesSortBy = "activity" | "created" | "sessions";
export type AdminWorkspacesSortDir = "asc" | "desc";

export interface AdminWorkspacesFilters {
  /** Matches workspace name, account name, or an account member email. */
  search?: string;
  accountId?: string;
  /** Physical `kortix.project_status` values; empty means no status filter. */
  status?: string[];
  sortBy?: AdminWorkspacesSortBy;
  sortDir?: AdminWorkspacesSortDir;
  page?: number;
  /** The server caps this value at 100. */
  limit?: number;
}

/** Read the platform-wide Workspace fleet for the admin console. */
export function useAdminWorkspaces(filters: AdminWorkspacesFilters = {}) {
  const {
    search = "",
    accountId = "",
    status = [],
    sortBy = "activity",
    sortDir = "desc",
    page = 1,
    limit = 50,
  } = filters;

  return useQuery<AdminWorkspacesResponse>({
    queryKey: [
      "admin",
      "workspaces",
      search,
      accountId,
      status.join(","),
      sortBy,
      sortDir,
      page,
      limit,
    ],
    queryFn: async () => {
      const query = new URLSearchParams();
      if (search) query.set("search", search);
      if (accountId) query.set("accountId", accountId);
      if (status.length) query.set("status", status.join(","));
      query.set("sortBy", sortBy);
      query.set("sortDir", sortDir);
      query.set("page", String(page));
      query.set("limit", String(limit));

      const response = await backendApi.get<AdminWorkspacesResponse>(
        `/admin/api/workspaces?${query.toString()}`,
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    staleTime: 15_000,
    placeholderData: (previous) => previous,
  });
}
