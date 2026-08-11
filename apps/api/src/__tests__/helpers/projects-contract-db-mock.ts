import {
  accountGithubInstallations,
  accountMembers,
  projectGitConnections,
  projectMembers,
  projects,
} from '@kortix/db';

import {
  collectConditionValues,
  extractStringArray,
  queryResult,
} from './drizzle-query-mock';

export type AccountRole = 'owner' | 'admin' | 'member';
export type WorkspaceRole = 'manager' | 'editor' | 'member';

export interface WorkspaceRow {
  workspaceId: string;
  accountId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath: string;
  status: 'active' | 'archived';
  metadata: Record<string, unknown>;
  lastOpenedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountMemberRow {
  userId: string;
  accountId: string;
  accountRole: AccountRole;
  joinedAt: Date;
}

export interface WorkspaceMemberRow {
  accountId: string;
  workspaceId: string;
  userId: string;
  projectRole: WorkspaceRole;
  grantedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspacesContractDbState {
  accountMemberRows: AccountMemberRow[];
  projectRows: WorkspaceRow[];
  projectMemberRows: WorkspaceMemberRow[];
  installationRow: typeof accountGithubInstallations.$inferSelect | null;
  gitConnectionRows: Array<typeof projectGitConnections.$inferSelect>;
  nextWorkspaceIds: string[];
}

export const baseDate = new Date('2026-01-01T00:00:00Z');

export function projectRow(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    workspaceId: '00000000-0000-4000-a000-000000000201',
    accountId: '00000000-0000-4000-a000-000000000101',
    name: 'Existing Workspace',
    repoUrl: 'https://github.com/kortix/existing-project.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    metadata: {},
    lastOpenedAt: null,
    createdAt: baseDate,
    updatedAt: baseDate,
    ...overrides,
  };
}

function selectRows(
  state: WorkspacesContractDbState,
  table: unknown,
  fields: Record<string, unknown> | undefined,
  condition: unknown,
): any[] {
  const values = collectConditionValues(condition);
  const accountId = values.account_id as string | undefined;
  const userId = values.user_id as string | undefined;
  const workspaceId = values.project_id as string | undefined;
  const repoUrl = values.repo_url as string | undefined;
  const status = values.status as string | undefined;

  if (table === accountMembers) {
    return state.accountMemberRows.filter(
      (row) =>
        (!accountId || row.accountId === accountId) &&
        (!userId || row.userId === userId),
    );
  }
  if (table === projectMembers) {
    const rows = state.projectMemberRows.filter(
      (row) =>
        (!accountId || row.accountId === accountId) &&
        (!workspaceId || row.workspaceId === workspaceId) &&
        (!userId || row.userId === userId),
    );
    // Drizzle applies the canonical alias in
    // `.select({ workspaceRole: projectMembers.projectRole })`. Preserve that
    // projection in this black-box DB fixture instead of returning only the
    // physical `projectRole` column name.
    return fields && Object.hasOwn(fields, 'workspaceRole')
      ? rows.map((row) => ({ ...row, workspaceRole: row.projectRole }))
      : rows;
  }
  if (table === accountGithubInstallations)
    return state.installationRow ? [state.installationRow] : [];
  if (table === projectGitConnections) {
    return state.gitConnectionRows.filter(
      (row) =>
        (!accountId || row.accountId === accountId) &&
        (!workspaceId || row.workspaceId === workspaceId),
    );
  }
  if (table === projects) {
    const inArrayWorkspaceIds = extractStringArray(condition);
    return state.projectRows.filter(
      (row) =>
        (!accountId || row.accountId === accountId) &&
        (!workspaceId || row.workspaceId === workspaceId) &&
        (!repoUrl || row.repoUrl === repoUrl) &&
        (!status || row.status === status) &&
        (!inArrayWorkspaceIds || inArrayWorkspaceIds.includes(row.workspaceId)),
    );
  }
  return [];
}

function insertWorkspace(state: WorkspacesContractDbState, values: any) {
  const workspaceId = state.nextWorkspaceIds.shift();
  if (!workspaceId) throw new Error('test project id pool exhausted');
  const row: WorkspaceRow = {
    workspaceId,
    accountId: values.accountId,
    name: values.name,
    repoUrl: values.repoUrl,
    defaultBranch: values.defaultBranch ?? 'main',
    manifestPath: values.manifestPath ?? 'kortix.yaml',
    status: values.status ?? 'active',
    metadata: values.metadata ?? {},
    lastOpenedAt: null,
    createdAt: baseDate,
    updatedAt: values.updatedAt ?? baseDate,
  };
  state.projectRows.push(row);
  return row;
}

function grantWorkspaceRole(
  state: WorkspacesContractDbState,
  values: any,
  set?: Partial<WorkspaceMemberRow>,
) {
  const existing = state.projectMemberRows.find(
    (row) => row.workspaceId === values.workspaceId && row.userId === values.userId,
  );
  if (existing) {
    Object.assign(existing, set ?? values);
    return existing;
  }
  const row: WorkspaceMemberRow = {
    accountId: values.accountId,
    workspaceId: values.workspaceId,
    userId: values.userId,
    projectRole: values.projectRole,
    grantedBy: values.grantedBy ?? null,
    createdAt: baseDate,
    updatedAt: values.updatedAt ?? baseDate,
  };
  state.projectMemberRows.push(row);
  return row;
}

export function createWorkspacesContractDbMock(
  state: WorkspacesContractDbState,
): any {
  const dbMock: any = {
    execute: async () => [],
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (condition: unknown) =>
          queryResult(selectRows(state, table, fields, condition)),
        orderBy: async () => selectRows(state, table, fields, undefined),
        innerJoin: () => ({
          where: (condition: unknown) =>
            queryResult(selectRows(state, table, fields, condition)),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        onConflictDoNothing: () => ({
          returning: async () => [],
        }),
        onConflictDoUpdate: ({ set }: { set?: Record<string, unknown> }) => ({
          returning: async () => {
            if (table === projects) {
              throw new Error(
                'project imports must insert instead of updating by repository',
              );
            }
            if (table === projectGitConnections) {
              const existingIndex = state.gitConnectionRows.findIndex(
                (row) => row.workspaceId === values.workspaceId,
              );
              const existing = state.gitConnectionRows[existingIndex];
              const row = {
                connectionId:
                  existing?.connectionId ??
                  '00000000-0000-4000-a000-000000000501',
                accountId: values.accountId,
                workspaceId: values.workspaceId,
                provider: values.provider,
                repoUrl: values.repoUrl,
                repoOwner: values.repoOwner ?? null,
                repoName: values.repoName ?? null,
                externalRepoId: values.externalRepoId ?? null,
                defaultBranch: values.defaultBranch,
                authMethod: values.authMethod,
                installationId: values.installationId ?? null,
                credentialRef: values.credentialRef ?? null,
                permissions: values.permissions ?? {},
                visibility: values.visibility ?? null,
                webhookId: values.webhookId ?? null,
                status: values.status ?? 'connected',
                lastValidatedAt: values.lastValidatedAt ?? baseDate,
                lastErrorCode: values.lastErrorCode ?? null,
                lastErrorMessage: values.lastErrorMessage ?? null,
                metadata: values.metadata ?? {},
                createdAt: existing?.createdAt ?? baseDate,
                updatedAt: values.updatedAt ?? baseDate,
              } as typeof projectGitConnections.$inferSelect;
              if (existingIndex >= 0)
                state.gitConnectionRows[existingIndex] = row;
              else state.gitConnectionRows.push(row);
              return [row];
            }
            return table === projectMembers
              ? [
                  grantWorkspaceRole(
                    state,
                    values,
                    set as Partial<WorkspaceMemberRow>,
                  ),
                ]
              : [];
          },
          then: (
            resolve: (value: unknown[]) => unknown,
            reject?: (reason: unknown) => unknown,
          ) =>
            Promise.resolve(
              table === projectMembers
                ? [
                    grantWorkspaceRole(
                      state,
                      values,
                      set as Partial<WorkspaceMemberRow>,
                    ),
                  ]
                : [],
            ).then(resolve, reject),
          catch: () => undefined,
        }),
        returning: async () => {
          if (table === projects) return [insertWorkspace(state, values)];
          if (table === projectGitConnections) {
            return dbMock
              .insert(table)
              .values(values)
              .onConflictDoUpdate({})
              .returning();
          }
          return table === projectMembers
            ? [grantWorkspaceRole(state, values)]
            : [];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (updates: Partial<WorkspaceRow>) => ({
        where: (condition: unknown) => {
          const update = async () => {
            const values = collectConditionValues(condition);
            if (table !== projects) return [];
            const row = state.projectRows.find(
              (project) => project.workspaceId === values.project_id,
            );
            if (!row) return [];
            const normalizedUpdates = { ...updates };
            if (
              normalizedUpdates.metadata &&
              typeof normalizedUpdates.metadata === 'object' &&
              'queryChunks' in normalizedUpdates.metadata
            ) {
              delete normalizedUpdates.metadata;
            }
            Object.assign(row, normalizedUpdates);
            return [row];
          };
          return {
            returning: update,
            then: (
              resolve: (value: unknown[]) => unknown,
              reject?: (reason: unknown) => unknown,
            ) => update().then(resolve, reject),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        const values = collectConditionValues(condition);
        if (table === projectMembers) {
          state.projectMemberRows = state.projectMemberRows.filter(
            (row) =>
              !(
                (!values.project_id || row.workspaceId === values.project_id) &&
                (!values.user_id || row.userId === values.user_id)
              ),
          );
        }
      },
    }),
  };
  dbMock.transaction = async (run: (tx: typeof dbMock) => Promise<unknown>) =>
    run(dbMock);
  return dbMock;
}
