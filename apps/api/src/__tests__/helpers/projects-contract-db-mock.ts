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
export type ProjectRole = 'manager' | 'editor' | 'member';

export interface ProjectRow {
  projectId: string;
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

export interface ProjectMemberRow {
  accountId: string;
  projectId: string;
  userId: string;
  projectRole: ProjectRole;
  grantedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectsContractDbState {
  accountMemberRows: AccountMemberRow[];
  projectRows: ProjectRow[];
  projectMemberRows: ProjectMemberRow[];
  installationRow: typeof accountGithubInstallations.$inferSelect | null;
  gitConnectionRows: Array<typeof projectGitConnections.$inferSelect>;
  nextProjectIds: string[];
  repoUniquenessEnforced: boolean;
}

export const baseDate = new Date('2026-01-01T00:00:00Z');

export function projectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    projectId: '00000000-0000-4000-a000-000000000201',
    accountId: '00000000-0000-4000-a000-000000000101',
    name: 'Existing Project',
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
  state: ProjectsContractDbState,
  table: unknown,
  fields: Record<string, unknown> | undefined,
  condition: unknown,
): any[] {
  const values = collectConditionValues(condition);
  const accountId = values.account_id as string | undefined;
  const userId = values.user_id as string | undefined;
  const projectId = values.project_id as string | undefined;
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
    return state.projectMemberRows.filter(
      (row) =>
        (!accountId || row.accountId === accountId) &&
        (!projectId || row.projectId === projectId) &&
        (!userId || row.userId === userId),
    );
  }
  if (table === accountGithubInstallations)
    return state.installationRow ? [state.installationRow] : [];
  if (table === projectGitConnections) {
    return state.gitConnectionRows.filter(
      (row) =>
        (!accountId || row.accountId === accountId) &&
        (!projectId || row.projectId === projectId),
    );
  }
  if (table === projects) {
    const inArrayProjectIds = extractStringArray(condition);
    return state.projectRows.filter(
      (row) =>
        (!accountId || row.accountId === accountId) &&
        (!projectId || row.projectId === projectId) &&
        (!repoUrl || row.repoUrl === repoUrl) &&
        (!status || row.status === status) &&
        (!inArrayProjectIds || inArrayProjectIds.includes(row.projectId)),
    );
  }
  return [];
}

function insertProject(state: ProjectsContractDbState, values: any) {
  const projectId = state.nextProjectIds.shift();
  if (!projectId) throw new Error('test project id pool exhausted');
  const row: ProjectRow = {
    projectId,
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

function grantProjectRole(
  state: ProjectsContractDbState,
  values: any,
  set?: Partial<ProjectMemberRow>,
) {
  const existing = state.projectMemberRows.find(
    (row) => row.projectId === values.projectId && row.userId === values.userId,
  );
  if (existing) {
    Object.assign(existing, set ?? values);
    return existing;
  }
  const row: ProjectMemberRow = {
    accountId: values.accountId,
    projectId: values.projectId,
    userId: values.userId,
    projectRole: values.projectRole,
    grantedBy: values.grantedBy ?? null,
    createdAt: baseDate,
    updatedAt: values.updatedAt ?? baseDate,
  };
  state.projectMemberRows.push(row);
  return row;
}

export function createProjectsContractDbMock(
  state: ProjectsContractDbState,
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
          returning: async () => {
            if (table !== projects) return [];
            const conflicts =
              state.repoUniquenessEnforced &&
              state.projectRows.some(
                (row) =>
                  row.accountId === values.accountId &&
                  row.repoUrl === values.repoUrl,
              );
            return conflicts ? [] : [insertProject(state, values)];
          },
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
                (row) => row.projectId === values.projectId,
              );
              const existing = state.gitConnectionRows[existingIndex];
              const row = {
                connectionId:
                  existing?.connectionId ??
                  '00000000-0000-4000-a000-000000000501',
                accountId: values.accountId,
                projectId: values.projectId,
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
                  grantProjectRole(
                    state,
                    values,
                    set as Partial<ProjectMemberRow>,
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
                    grantProjectRole(
                      state,
                      values,
                      set as Partial<ProjectMemberRow>,
                    ),
                  ]
                : [],
            ).then(resolve, reject),
          catch: () => undefined,
        }),
        returning: async () => {
          if (table === projects) return [insertProject(state, values)];
          if (table === projectGitConnections) {
            return dbMock
              .insert(table)
              .values(values)
              .onConflictDoUpdate({})
              .returning();
          }
          return table === projectMembers
            ? [grantProjectRole(state, values)]
            : [];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (updates: Partial<ProjectRow>) => ({
        where: (condition: unknown) => {
          const update = async () => {
            const values = collectConditionValues(condition);
            if (table !== projects) return [];
            const row = state.projectRows.find(
              (project) => project.projectId === values.project_id,
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
                (!values.project_id || row.projectId === values.project_id) &&
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
