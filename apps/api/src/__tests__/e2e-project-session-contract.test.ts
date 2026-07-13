import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  projectGitConnections,
  projectGitCredentials,
  projectMembers,
  projectSecrets,
  projectSessionRuntimeContexts,
  projectSessions,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mockIamEngineAllowAll, mockIamMembershipSyncNoop } from './helpers/iam-mocks';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const SESSION_ID = '00000000-0000-4000-a000-000000000301';
const TEST_GITHUB_OWNER = 'kortix-org';
const PROJECT_RUNTIME_PAT = 'kortix_pat_project_runtime';
const PROJECT_SANDBOX_TOKEN = 'kortix_sb_project_runtime';
const ORIGINAL_KORTIX_GITHUB_OWNER = process.env.KORTIX_GITHUB_OWNER;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;
const ORIGINAL_KORTIX_URL = process.env.KORTIX_URL;

process.env.KORTIX_GITHUB_OWNER = TEST_GITHUB_OWNER;
process.env.API_KEY_SECRET = 'test-project-secret-key-material-32-bytes';
process.env.KORTIX_URL = 'https://api.test.kortix.local';

let branchCreateCalls = 0;
let sandboxProvisionCalls = 0;
let providerStartCalls = 0;
let providerStatus = 'stopped';
let providerStatusAfterStart: string | null = null;
let providerStartError: Error | null = null;
let providerStartGate: Promise<void> | null = null;
let releaseProviderStart: (() => void) | null = null;
let providerRecoveryCalls = 0;
let providerRecoveryEnabled = false;
let providerRecoveryStatus: 'running' | 'recovering' | 'unavailable' = 'unavailable';
let providerRecoveryGate: Promise<void> | null = null;
let releaseProviderRecovery: (() => void) | null = null;
let computeReopenCalls = 0;
let opencodeEnsureReason: 'unchanged' | 'healed' | 'not_ready' | 'unreachable' = 'unchanged';
let activeSessionCount = 0;
let sessionRow: typeof projectSessions.$inferSelect | null;
let sessionSandboxRows: Array<typeof sessionSandboxes.$inferSelect>;
let secretRows: Array<typeof projectSecrets.$inferSelect>;
let runtimeContextRows: Array<typeof projectSessionRuntimeContexts.$inferSelect>;
let secretValues: Map<string, string>;
let gitConnectionRows: Array<typeof projectGitConnections.$inferSelect>;
let gitCredentialRows: Array<typeof projectGitCredentials.$inferSelect>;
let lastProvisionInput: {
  sandboxId: string;
  accountId: string;
  projectId: string;
  userId: string;
  provider?: string;
  extraEnvVars?: Record<string, string>;
  metadata?: Record<string, unknown>;
} | null = null;

const projectRow: typeof projects.$inferSelect = {
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  name: 'Contract Project',
  repoUrl: `https://github.com/${TEST_GITHUB_OWNER}/contract-project.git`,
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  status: 'active',
  metadata: {
    github: {
      auth_source: 'pat',
      full_name: `${TEST_GITHUB_OWNER}/contract-project`,
    },
  },
  lastOpenedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function resetState() {
  branchCreateCalls = 0;
  sandboxProvisionCalls = 0;
  providerStartCalls = 0;
  providerStatus = 'stopped';
  providerStatusAfterStart = null;
  providerStartError = null;
  providerStartGate = null;
  releaseProviderStart = null;
  providerRecoveryCalls = 0;
  providerRecoveryEnabled = false;
  providerRecoveryStatus = 'unavailable';
  providerRecoveryGate = null;
  releaseProviderRecovery = null;
  computeReopenCalls = 0;
  opencodeEnsureReason = 'unchanged';
  activeSessionCount = 0;
  lastProvisionInput = null;
  projectRow.repoUrl = `https://github.com/${TEST_GITHUB_OWNER}/contract-project.git`;
  projectRow.defaultBranch = 'main';
  projectRow.metadata = {
    github: {
      auth_source: 'pat',
      full_name: `${TEST_GITHUB_OWNER}/contract-project`,
    },
  };
  sessionRow = {
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    branchName: SESSION_ID,
    baseRef: 'main',
    sandboxProvider: 'daytona',
    sandboxId: SESSION_ID,
    sandboxUrl: null,
    opencodeSessionId: null,
    agentName: 'default',
    status: 'provisioning',
    error: null,
    createdBy: USER_ID,
    visibility: 'private',
    metadata: { existing: true },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
  sessionSandboxRows = [];
  secretRows = [];
  runtimeContextRows = [];
  secretValues = new Map();
  gitConnectionRows = [];
  gitCredentialRows = [];
}

const realAuthMiddleware = await import('../middleware/auth');
mock.module('../middleware/auth', () => ({
  ...realAuthMiddleware,
  supabaseAuth: async (c: any, next: any) => {
    if (c.req.header('Authorization') === `Bearer ${PROJECT_SANDBOX_TOKEN}`) {
      c.set('userId', ACCOUNT_ID);
      c.set('userEmail', '');
      c.set('authType', 'apiKey');
      c.set('apiKeyType', 'sandbox');
      c.set('accountId', ACCOUNT_ID);
      c.set('sandboxId', SESSION_ID);
      await next();
      return;
    }
    if (c.req.header('Authorization') === `Bearer ${PROJECT_RUNTIME_PAT}`) {
      c.set('userId', USER_ID);
      c.set('userEmail', '');
      c.set('authType', 'pat');
      c.set('accountId', ACCOUNT_ID);
      c.set('tokenProjectId', PROJECT_ID);
      c.set('iamTokenId', '00000000-0000-4000-a000-000000000901');
      await next();
      return;
    }
    c.set('userId', USER_ID);
    c.set('userEmail', 'contract@example.test');
    c.set('authType', 'supabase');
    await next();
  },
}));

mock.module('../projects/git', () => ({
  createRemoteSessionBranch: async () => {
    branchCreateCalls += 1;
  },
  archiveRepoSubtree: async () => undefined,
  deleteRemoteSessionBranch: async () => undefined,
  listRepoFiles: async () => [],
  searchRepoFileNames: async () => [],
  grepRepoFiles: async () => [],
  loadProjectConfig: async () => ({}),
  readRepoFile: async () => '',
  // compile-agent-config.ts (the agent-first v2 compiler) reads the manifest
  // straight from git — no manifest ⇒ null ⇒ the v1-shaped projects this suite
  // exercises get no compiled agent config, matching their pre-compiler behavior.
  readManifestFromRepo: async () => null,
  invalidateProjectMirror: () => {},
  listBranches: async () => [],
  listCommits: async () => ({ entries: [], nextCursor: null }),
  getCommit: async () => null,
  getCommitDiff: async () => null,
  diffStat: async () => ({ filesChanged: 0, insertions: 0, deletions: 0 }),
  getFileHistory: async () => ({ entries: [], nextCursor: null }),
  getFileAtRef: async () => null,
  resolveCommitSha: async () => 'a'.repeat(40),
  resolveBranchTip: async () => 'a'.repeat(40),
  resolveBranchAheadState: async () => ({ ahead: 0, behind: 0 }),
  getBranchDiff: async () => ({ files: [], diff: '' }),
  getDiffBetweenShas: async () => ({ files: [], diff: '' }),
  previewMerge: async () => ({ canMerge: true, conflicts: [] }),
  mergeBranches: async () => ({ mergedSha: 'a'.repeat(40) }),
  commitFileToBranch: async () => ({ commitSha: 'a'.repeat(40) }),
}));

mock.module('../snapshots/builder', () => ({
  ensureSandboxImage: async () => ({
    snapshotName: 'kortix-default-test',
    slug: 'default',
    contentHash: 'a'.repeat(64),
    built: false,
    isDefault: true,
  }),
  deleteSandboxImage: async () => ({
    deleted: false,
    snapshotName: 'kortix-default-test',
    slug: 'default',
  }),
  listSnapshotBuilds: async () => [],
  listSandboxTemplates: async () => [],
  resolveTemplate: async () => ({ slug: 'default', spec: {}, isDefault: true }),
  kickPreBuild: () => {},
  kickProjectTemplatePrebuilds: () => {},
  kickStartupPreBuild: () => {},
  reconcileProjectTemplates: async () => undefined,
  reconcileStaleBuilds: async () => undefined,
  ensurePlatformDefaultImage: async () => undefined,
  resolveCommitSha: async () => 'a'.repeat(40),
  DEFAULT_SANDBOX_SLUG: 'default',
}));

mock.module('../projects/github', () => ({
  parseGitHubRepoUrl: (repoUrl: string) => ({
    owner: TEST_GITHUB_OWNER,
    repo:
      repoUrl
        .split('/')
        .pop()
        ?.replace(/\.git$/, '') ?? 'contract-project',
  }),
  buildGitHubAppInstallUrl: () => 'https://github.com/apps/kortix-test/installations/new',
  verifyGitHubAppInstallState: (state: string) => state,
  verifyGitHubAppInstallStatePayload: (state: string) => ({
    accountId: state,
    nonce: 'test-nonce',
    issuedAt: Math.floor(Date.now() / 1000),
  }),
  createGitHubAppJwt: () => 'jwt-test',
  getGitHubPatAuthContext: () => ({
    token: 'pat-token',
    source: 'pat',
    owner: 'kortix-org',
  }),
  deleteFile: async () => undefined,
  commitFile: async () => undefined,
  createInstallationToken: async () => ({ token: 'installation-token' }),
  createRepo: async () => {
    throw new Error('not used');
  },
  getFileSha: async () => null,
  getGitHubAppInstallation: async () => ({
    account: { login: 'kortix-org', type: 'Organization' },
    repository_selection: 'all',
    permissions: {},
  }),
  getRepo: async () => ({
    id: 7,
    name: 'contract-project',
    full_name: 'kortix-org/contract-project',
    private: true,
    html_url: 'https://github.com/kortix-org/contract-project',
    clone_url: 'https://github.com/kortix-org/contract-project.git',
    ssh_url: 'git@github.com:kortix-org/contract-project.git',
    default_branch: 'main',
    description: null,
  }),
  listInstallationRepositories: async () => [],
  isGithubAppConfigured: () => false,
  isGithubPatConfigured: () => true,
  isOrgAccount: async () => true,
  deleteRepo: async () => undefined,
  addCollaborator: async () => undefined,
  getBranchCommitSha: async () => 'a'.repeat(40),
  createBranchRef: async () => undefined,
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async (input: any) => {
    sandboxProvisionCalls += 1;
    lastProvisionInput = input;
  },
}));

mock.module('../platform/providers', () => ({
  WarmRuntimeUnavailableError: class WarmRuntimeUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WarmRuntimeUnavailableError';
    }
  },
  getProvider: () => ({
    getStatus: async () => providerStatus,
    start: async () => {
      providerStartCalls += 1;
      if (providerStartError) throw providerStartError;
      if (providerStatusAfterStart) providerStatus = providerStatusAfterStart;
      if (providerStartGate) await providerStartGate;
    },
    stop: async () => undefined,
    remove: async () => undefined,
    ...(providerRecoveryEnabled
      ? {
          recoverInPlace: async () => {
            providerRecoveryCalls += 1;
            if (providerRecoveryGate) await providerRecoveryGate;
            return providerRecoveryStatus;
          },
        }
      : {}),
  }),
}));

mock.module('../projects/opencode-mapping', () => ({
  pickCanonicalRoot: () => 'ses_root_existing',
  resolveRootSessionId: () => 'ses_root_existing',
  sandboxOpencodeEndpoint: async () => null,
  listSandboxOpencodeSessions: async () => ({
    ok: false,
    reason: opencodeEnsureReason === 'not_ready' ? 'not_ready' : 'unreachable',
  }),
  ensureOpencodeSessionPin: async (input: { currentPin: string | null }) => ({
    pin: input.currentPin ?? 'ses_root_existing',
    changed: false,
    reason: opencodeEnsureReason,
    sessions: [],
  }),
}));

mock.module('../billing/services/compute-metering', () => ({
  reopenComputeForSandbox: async () => {
    computeReopenCalls += 1;
  },
  endComputeSession: async () => undefined,
  pauseComputeSession: async () => undefined,
  startComputeSession: async () => undefined,
  tickRunningComputeCharges: async () => undefined,
}));

// Session create runs the billing gate. Return a billing-active account so the
// contract holds regardless of whether KORTIX_BILLING_INTERNAL_ENABLED is set
// in the run environment (the gate is a no-op when billing is disabled).
mock.module('../billing/repositories/credit-accounts', () => ({
  getSubscriptionInfo: async () => ({ tier: 'pro' }),
  getCreditAccount: async () => ({
    accountId: ACCOUNT_ID,
    balance: 1_000_000,
    billingModel: 'credits',
    stripeSubscriptionId: 'sub_test',
    stripeSubscriptionStatus: 'active',
  }),
  getCreditBalance: async () => ({
    balance: 1_000_000,
    granted: 1_000_000,
    used: 0,
  }),
  upsertCreditAccount: async () => {},
  updateCreditAccount: async () => {},
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
  resolveScopedAccountId: async () => ACCOUNT_ID,
}));

mockIamEngineAllowAll();

mockIamMembershipSyncNoop();

mock.module('../repositories/account-tokens', () => ({
  createAccountToken: async () => ({ secretKey: PROJECT_RUNTIME_PAT }),
  listAccountTokens: async () => [],
  revokeAccountToken: async () => true,
  validateAccountToken: async () => null,
}));

// Pin the concurrent-session cap to 1 regardless of env mode so this test
// always exercises the rate-limit branch — the real implementation bypasses
// the cap when KORTIX_BILLING_INTERNAL_ENABLED is false.
mock.module('../shared/account-limits', () => ({
  resolveAccountTier: async () => 'free',
  maxConcurrentSessionsForTier: () => 1,
  resolveAccountSessionLimit: async () => ({
    tier: 'free',
    limit: 1,
    source: 'tier',
  }),
  sessionLlmPolicyForTier: () => ({ limit: 60, windowMs: 60_000 }),
  maxProjectsForAccount: async () => 100,
  accountEntitledToLlmGateway: async () => true,
  FREE_TIER_PROJECT_LIMIT: 1,
  clearAccountLimitCache: () => undefined,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: async () => ({
          data: { user: { email: 'contract@example.test' } },
        }),
      },
    },
  }),
}));

mock.module('../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    transaction: async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn(this);
    },
    execute: async () => [],
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => ({
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => {
            Promise.resolve(table === projectSecrets ? secretRows : []).then(resolve, reject);
          },
          orderBy: async () => {
            if (table === projectSecrets) return secretRows;
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            return [];
          },
          limit: async () => {
            if (fields && Object.keys(fields).includes('activeCount'))
              return [{ activeCount: activeSessionCount }];
            if (table === projectSecrets) {
              return secretRows.filter((row) => row.name === 'KORTIX_GIT_AUTH_TOKEN').slice(0, 1);
            }
            if (table === projectSessionRuntimeContexts) return runtimeContextRows.slice(0, 1);
            if (table === projectGitConnections) return gitConnectionRows.slice(0, 1);
            if (table === projectGitCredentials) return gitCredentialRows.slice(0, 1);
            if (table === sessionSandboxes) return sessionSandboxRows.slice(0, 1);
            if (table === projects) return [projectRow];
            if (table === accountMembers) return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
            if (table === projectMembers) return [];
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            return [];
          },
        }),
        orderBy: async () => {
          if (table === projectSessions) return sessionRow ? [sessionRow] : [];
          if (table === projectSecrets) return secretRows;
          return [];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        returning: async () => {
          if (table === projectGitConnections) {
            const existingIndex = gitConnectionRows.findIndex(
              (row) => row.projectId === values.projectId,
            );
            const now = new Date('2026-01-02T00:00:00Z');
            const row = {
              connectionId:
                existingIndex >= 0
                  ? gitConnectionRows[existingIndex]!.connectionId
                  : '00000000-0000-4000-a000-000000000501',
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
              lastValidatedAt: values.lastValidatedAt ?? now,
              lastErrorCode: values.lastErrorCode ?? null,
              lastErrorMessage: values.lastErrorMessage ?? null,
              metadata: values.metadata ?? {},
              createdAt: existingIndex >= 0 ? gitConnectionRows[existingIndex]!.createdAt : now,
              updatedAt: values.updatedAt ?? now,
            } as typeof projectGitConnections.$inferSelect;
            if (existingIndex >= 0) gitConnectionRows[existingIndex] = row;
            else gitConnectionRows.push(row);
            return [row];
          }
          if (table === projectGitCredentials) {
            const existingIndex = gitCredentialRows.findIndex(
              (row) => row.projectId === values.projectId && row.provider === values.provider,
            );
            const now = new Date('2026-01-02T00:00:00Z');
            const row = {
              credentialId:
                existingIndex >= 0
                  ? gitCredentialRows[existingIndex]!.credentialId
                  : '00000000-0000-4000-a000-000000000601',
              accountId: values.accountId,
              projectId: values.projectId,
              provider: values.provider,
              authMethod: values.authMethod ?? 'token',
              valueEnc: values.valueEnc,
              createdBy: values.createdBy ?? null,
              createdAt: existingIndex >= 0 ? gitCredentialRows[existingIndex]!.createdAt : now,
              updatedAt: values.updatedAt ?? now,
            } as typeof projectGitCredentials.$inferSelect;
            if (existingIndex >= 0) gitCredentialRows[existingIndex] = row;
            else gitCredentialRows.push(row);
            return [row];
          }
          if (table === projectSessionRuntimeContexts) {
            const row: typeof projectSessionRuntimeContexts.$inferSelect = {
              sessionId: values.sessionId,
              context: values.context,
              byteSize: values.byteSize,
              createdAt: new Date('2026-01-02T00:00:00Z'),
              updatedAt: values.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
            };
            runtimeContextRows = [row];
            return [row];
          }
          if (table !== projectSessions) return [];
          sessionRow = {
            sessionId: values.sessionId,
            accountId: values.accountId,
            projectId: values.projectId,
            branchName: values.branchName,
            baseRef: values.baseRef,
            sandboxProvider: values.sandboxProvider,
            sandboxId: values.sandboxId,
            sandboxUrl: null,
            opencodeSessionId: null,
            agentName: values.agentName,
            status: values.status,
            error: null,
            createdBy: values.createdBy ?? null,
            visibility: values.visibility ?? 'private',
            metadata: values.metadata ?? {},
            createdAt: new Date('2026-01-02T00:00:00Z'),
            updatedAt: values.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
          };
          return [sessionRow];
        },
        onConflictDoNothing: async () => [],
        onConflictDoUpdate: ({
          set,
        }: {
          set: Partial<typeof projectSecrets.$inferInsert>;
        }) => {
          const conflictResult = {
            returning: async () => {
            if (table === projectGitConnections) {
              const existingIndex = gitConnectionRows.findIndex(
                (row) => row.projectId === values.projectId,
              );
              const now = new Date('2026-01-02T00:00:00Z');
              const row = {
                connectionId:
                  existingIndex >= 0
                    ? gitConnectionRows[existingIndex]!.connectionId
                    : '00000000-0000-4000-a000-000000000501',
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
                lastValidatedAt: values.lastValidatedAt ?? now,
                lastErrorCode: values.lastErrorCode ?? null,
                lastErrorMessage: values.lastErrorMessage ?? null,
                metadata: values.metadata ?? {},
                  createdAt: existingIndex >= 0 ? gitConnectionRows[existingIndex]!.createdAt : now,
                updatedAt: values.updatedAt ?? now,
              } as typeof projectGitConnections.$inferSelect;
              if (existingIndex >= 0) gitConnectionRows[existingIndex] = row;
              else gitConnectionRows.push(row);
              return [row];
            }
            if (table === projectGitCredentials) {
              const existingIndex = gitCredentialRows.findIndex(
                  (row) => row.projectId === values.projectId && row.provider === values.provider,
              );
              const now = new Date('2026-01-02T00:00:00Z');
              const row = {
                credentialId:
                  existingIndex >= 0
                    ? gitCredentialRows[existingIndex]!.credentialId
                    : '00000000-0000-4000-a000-000000000601',
                accountId: values.accountId,
                projectId: values.projectId,
                provider: values.provider,
                authMethod: values.authMethod ?? 'token',
                valueEnc: values.valueEnc,
                createdBy: values.createdBy ?? null,
                  createdAt: existingIndex >= 0 ? gitCredentialRows[existingIndex]!.createdAt : now,
                updatedAt: values.updatedAt ?? now,
              } as typeof projectGitCredentials.$inferSelect;
              if (existingIndex >= 0) gitCredentialRows[existingIndex] = row;
              else gitCredentialRows.push(row);
              return [row];
            }
            if (table !== projectSecrets) return [];
            const existingIndex = secretRows.findIndex(
                (row) => row.projectId === values.projectId && row.name === values.name,
            );
            const now = new Date('2026-01-02T00:00:00Z');
            const row: typeof projectSecrets.$inferSelect = {
              secretId:
                existingIndex >= 0
                  ? secretRows[existingIndex]!.secretId
                  : '00000000-0000-4000-a000-000000000401',
              projectId: values.projectId!,
              identifier: values.identifier ?? values.name!,
              name: values.name!,
              valueEnc: (set.valueEnc ?? values.valueEnc)!,
              scope: values.scope ?? 'runtime',
              ownerUserId: values.ownerUserId ?? null,
              active: values.active ?? true,
              createdBy: values.createdBy ?? null,
                createdAt: existingIndex >= 0 ? secretRows[existingIndex]!.createdAt : now,
              updatedAt: (set.updatedAt ?? values.updatedAt ?? now) as Date,
            };
            if (existingIndex >= 0) secretRows[existingIndex] = row;
            else secretRows.push(row);
            return [row];
          },
            then: (
              resolve: (value: unknown[]) => unknown,
              reject?: (reason: unknown) => unknown,
            ) => {
              conflictResult.returning().then(resolve, reject);
            },
            catch: (reject: (reason: unknown) => unknown) => {
              conflictResult.returning().catch(reject);
            },
          };
          return conflictResult;
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === projectSecrets) secretRows = [];
        if (table === projectSessionRuntimeContexts) runtimeContextRows = [];
        if (table === sessionSandboxes) sessionSandboxRows = [];
        if (table === projectSessions) {
          sessionRow = null;
          runtimeContextRows = [];
        }
      },
    }),
    update: (table: unknown) => ({
      set: (
        updates: Partial<typeof projectSessions.$inferSelect> &
          Partial<typeof sessionSandboxes.$inferSelect>,
      ) => ({
        where: () => ({
          returning: async () => {
            if (table === projectSessions) {
              if (!sessionRow) return [];
              if (
                typeof (sessionRow.metadata as Record<string, unknown> | null)?.deletedAt ===
                  'string' &&
                !('metadata' in updates)
              )
                return [];
              sessionRow = {
                ...sessionRow,
                ...updates,
                updatedAt: updates.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
              };
              return [sessionRow];
            }
            if (table === sessionSandboxes) {
              const row = sessionSandboxRows[0];
              if (!row) return [];
              sessionSandboxRows[0] = {
                ...row,
                ...updates,
                updatedAt: updates.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
              };
              return [sessionSandboxRows[0]];
            }
            return [];
          },
          then: async (
            resolve: (value: unknown[]) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => {
            try {
              const rows = await (async () => {
                if (table === projectSessions) {
                  if (!sessionRow) return [];
                  sessionRow = {
                    ...sessionRow,
                    ...updates,
                    updatedAt: updates.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
                  };
                  return [sessionRow];
                }
                if (table === sessionSandboxes) {
                  const row = sessionSandboxRows[0];
                  if (!row) return [];
                  sessionSandboxRows[0] = {
                    ...row,
                    ...updates,
                    updatedAt: updates.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
                  };
                  return [sessionSandboxRows[0]];
                }
                return [];
              })();
              return resolve(rows);
            } catch (err) {
              return reject?.(err);
            }
          },
          catch: async (reject: (reason: unknown) => unknown) => {
            try {
              if (table === projectSessions) {
                if (!sessionRow) return [];
                sessionRow = {
                  ...sessionRow,
                  ...updates,
                  updatedAt: updates.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
                };
                return [sessionRow];
              }
              if (table === sessionSandboxes) {
                const row = sessionSandboxRows[0];
                if (!row) return [];
                sessionSandboxRows[0] = {
                  ...row,
                  ...updates,
                  updatedAt: updates.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
                };
                return [sessionSandboxRows[0]];
              }
              return [];
            } catch (err) {
              return reject(err);
            }
          },
        }),
      }),
    }),
  },
}));

const { projectsApp } = await import('../projects/index');
const { encryptProjectSecret } = await import('../projects/secrets');

function createApp() {
  const app = new Hono();
  app.route('/v1/projects', projectsApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

/** Poll until predicate holds (or timeout) — robustly flushes the
 *  fire-and-forget sandbox-provision IIFE instead of a single racy tick. */
async function flushUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('project session API contract', () => {
  afterAll(() => {
    mock.restore();
    if (ORIGINAL_KORTIX_GITHUB_OWNER === undefined) {
      delete process.env.KORTIX_GITHUB_OWNER;
    } else {
      process.env.KORTIX_GITHUB_OWNER = ORIGINAL_KORTIX_GITHUB_OWNER;
    }
    if (ORIGINAL_API_KEY_SECRET === undefined) {
      delete process.env.API_KEY_SECRET;
    } else {
      process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
    }
    if (ORIGINAL_KORTIX_URL === undefined) {
      delete process.env.KORTIX_URL;
    } else {
      process.env.KORTIX_URL = ORIGINAL_KORTIX_URL;
    }
  });

  beforeEach(() => resetState());

  test('upserts and lists project secrets without exposing secret values', async () => {
    const app = createApp();

    const writeRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'OPENAI_API_KEY',
        value: 'sk-live-secret',
      }),
    });

    expect(writeRes.status).toBe(200);
    const written = await writeRes.json();
    expect(written.name).toBe('OPENAI_API_KEY');
    expect(written.scope).toBeUndefined();
    expect(written.value).toBeUndefined();
    expect(written.value_enc).toBeUndefined();
    expect(secretRows[0]?.valueEnc).not.toContain('sk-live-secret');

    const listRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets`);
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    const openAiSecret = listed.items.find((item: any) => item.name === 'OPENAI_API_KEY');
    const gitAuthSecret = listed.items.find((item: any) => item.name === 'KORTIX_GIT_AUTH_TOKEN');
    expect(openAiSecret).toBeTruthy();
    expect(openAiSecret.value).toBeUndefined();
    expect(openAiSecret.value_enc).toBeUndefined();
    expect(gitAuthSecret).toBeUndefined();
    expect(Array.isArray(listed.required)).toBe(true);
    expect(Array.isArray(listed.optional)).toBe(true);

    const deleteRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets/openai_api_key`, {
        method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });
    expect(secretRows).toHaveLength(0);
  });

  test('stores provider-neutral git credentials outside runtime project secrets', async () => {
    projectRow.repoUrl = 'https://gitlab.com/acme/private-project.git';
    projectRow.metadata = {
      git: { provider: 'gitlab', auth: { method: 'none' } },
    };
    const app = createApp();

    const before = await app.request(`/v1/projects/${PROJECT_ID}/secrets`);
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    expect(
      beforeBody.items.find((item: any) => item.name === 'KORTIX_GIT_AUTH_TOKEN'),
    ).toBeUndefined();

    const writeRes = await app.request(`/v1/projects/${PROJECT_ID}/git-credential`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'gitlab-project-token' }),
    });
    expect(writeRes.status).toBe(200);
    const written = await writeRes.json();
    expect(written).toMatchObject({
      configured: true,
      provider: 'gitlab',
      git_connection: {
        provider: 'gitlab',
        repo_url: 'https://gitlab.com/acme/private-project.git',
        auth_method: 'project_credential',
        status: 'connected',
      },
    });
    expect(written.value).toBeUndefined();
    expect(written.value_enc).toBeUndefined();
    expect(secretRows).toHaveLength(0);
    expect(gitCredentialRows).toHaveLength(1);
    expect(gitConnectionRows).toHaveLength(1);

    const deleteRes = await app.request(
      `/v1/projects/${PROJECT_ID}/secrets/KORTIX_GIT_AUTH_TOKEN`,
      {
        method: 'DELETE',
      },
    );
    expect(deleteRes.status).toBe(403);
    expect(secretRows).toHaveLength(0);

    const createRes = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'daytona', base_ref: 'main' }),
    });
    expect(createRes.status).toBe(201);

    await flushUntil(() => lastProvisionInput !== null);
    const env = lastProvisionInput!.extraEnvVars ?? {};
    expect(env.KORTIX_GIT_AUTH_TOKEN).toBeUndefined();
    expect(env.KORTIX_GITHUB_TOKEN).toBeUndefined();
    expect(env.KORTIX_CLI_TOKEN).toBeUndefined();
    expect(env.KORTIX_TOKEN).toBeUndefined();

    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: sessionRow!.sessionId,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'daytona',
        externalId: null,
        baseUrl: null,
        status: 'provisioning',
        config: {},
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];

    const cloneRes = await app.request(`/v1/projects/${PROJECT_ID}/git/clone-credential`, {
        headers: { Authorization: `Bearer ${PROJECT_SANDBOX_TOKEN}` },
    });
    expect(cloneRes.status).toBe(200);
    expect(await cloneRes.json()).toMatchObject({
      repo_url: 'https://gitlab.com/acme/private-project.git',
      source: 'project_credential',
      auth: {
        username: 'x-access-token',
        token: 'gitlab-project-token',
        type: 'basic',
      },
    });
  });

  test('resolves legacy git auth secret server-side without injecting it into sandbox env', async () => {
    projectRow.repoUrl = 'https://git.example.test/legacy-private-project';
    projectRow.metadata = {};
    secretRows = [
      {
        secretId: '00000000-0000-4000-a000-000000000402',
        projectId: PROJECT_ID,
        identifier: 'KORTIX_GIT_AUTH_TOKEN',
        name: 'KORTIX_GIT_AUTH_TOKEN',
        valueEnc: encryptProjectSecret(PROJECT_ID, 'legacy-git-token'),
        scope: 'runtime',
        ownerUserId: null,
        active: true,
        createdBy: USER_ID,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    const app = createApp();

    const createRes = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'daytona', base_ref: 'main' }),
    });
    expect(createRes.status).toBe(201);

    await flushUntil(() => lastProvisionInput !== null);
    const env = lastProvisionInput!.extraEnvVars ?? {};
    expect(env.KORTIX_GIT_AUTH_TOKEN).toBeUndefined();

    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: sessionRow!.sessionId,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'daytona',
        externalId: null,
        baseUrl: null,
        status: 'provisioning',
        config: {},
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];

    const cloneRes = await app.request(`/v1/projects/${PROJECT_ID}/git/clone-credential`, {
        headers: { Authorization: `Bearer ${PROJECT_SANDBOX_TOKEN}` },
    });
    expect(cloneRes.status).toBe(200);
    expect(await cloneRes.json()).toMatchObject({
      repo_url: 'https://git.example.test/legacy-private-project',
      source: 'project_credential',
      auth: {
        username: 'x-access-token',
        token: 'legacy-git-token',
        type: 'basic',
      },
    });
  });

  test('rejects reserved platform secret names', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'KORTIX_TOKEN',
        value: 'should-not-shadow-platform-auth',
      }),
    });

    expect(res.status).toBe(400);
    expect(secretRows).toHaveLength(0);
  });

  test('rejects server-managed and unknown PATCH fields', async () => {
    const app = createApp();
    const forbiddenBodies: Array<{
      body: Record<string, unknown>;
      message: string;
    }> = [
      {
        body: { status: 'running' },
        message: 'field is server-managed: status',
      },
      {
        body: { sandbox_url: 'https://sandbox.example' },
        message: 'field is server-managed: sandbox_url',
      },
      {
        body: { sandboxUrl: 'https://sandbox.example' },
        message: 'field is server-managed: sandboxUrl',
      },
      {
        body: { error: 'client-owned' },
        message: 'field is server-managed: error',
      },
      {
        body: { random: 'field' },
        message: 'field is not user-editable: random',
      },
    ];

    for (const { body, message } of forbiddenBodies) {
      const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: message });
    }
  });

  test('returns deterministic read errors for invalid or missing sessions and pending sandboxes', async () => {
    const app = createApp();

    const listSessions = await app.request(`/v1/projects/${PROJECT_ID}/sessions`);
    expect(listSessions.status).toBe(200);
    const sessions = await listSessions.json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      session_id: SESSION_ID,
      project_id: PROJECT_ID,
      branch_name: SESSION_ID,
      sandbox_id: SESSION_ID,
      status: 'provisioning',
    });

    const readSession = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`);
    expect(readSession.status).toBe(200);
    expect(await readSession.json()).toMatchObject({
      session_id: SESSION_ID,
      project_id: PROJECT_ID,
      branch_name: SESSION_ID,
      sandbox_id: SESSION_ID,
      status: 'provisioning',
    });

    const invalidSession = await app.request(`/v1/projects/${PROJECT_ID}/sessions/not-a-uuid`);
    expect(invalidSession.status).toBe(400);
    expect(await invalidSession.json()).toMatchObject({
      error: 'Invalid session id',
    });

    const invalidSandbox = await app.request(
      `/v1/projects/${PROJECT_ID}/sessions/not-a-uuid/start`,
      { method: 'POST' },
    );
    expect(invalidSandbox.status).toBe(400);
    expect(await invalidSandbox.json()).toMatchObject({
      error: 'Invalid session id',
    });

    // /start is idempotent: a session with no usable sandbox yet returns a
    // readiness payload (stage='provisioning'), not a 404 — the client polls it.
    const pendingSandbox = await app.request(
      `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`,
      { method: 'POST' },
    );
    expect(pendingSandbox.status).toBe(200);
    expect(await pendingSandbox.json()).toMatchObject({
      stage: 'provisioning',
      agent_name: 'default',
    });

    sessionRow = null;
    const missingSession = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`);
    expect(missingSession.status).toBe(404);
    expect(await missingSession.json()).toMatchObject({ error: 'Not found' });
  });

  test('dashboard start leaves fresh no-external-id provisioning rows alone', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'provisioning',
      sandboxProvider: 'daytona',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'daytona',
        externalId: null,
        baseUrl: null,
        status: 'provisioning',
        config: {},
        metadata: {
          initStatus: 'pending',
          initAttempts: 0,
          initMaxAttempts: 3,
          healthStatus: 'unknown',
        },
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'provisioning',
      retriable: true,
      sandbox: {
        sandbox_id: SESSION_ID,
        external_id: null,
        status: 'provisioning',
      },
    });
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionSandboxRows).toHaveLength(1);
  });

  test('dashboard start retires abandoned no-external-id provisioning rows and reallocates', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'provisioning',
      sandboxProvider: 'daytona',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'daytona',
        externalId: null,
        baseUrl: null,
        status: 'provisioning',
        config: {},
        metadata: {
          initStatus: 'pending',
          initAttempts: 0,
          initMaxAttempts: 3,
          healthStatus: 'unknown',
        },
        lastUsedAt: null,
        createdAt: new Date(Date.now() - 11 * 60 * 1000),
        updatedAt: new Date(Date.now() - 11 * 60 * 1000),
      },
    ];

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'provisioning',
      agent_name: 'default',
      retriable: true,
      sandbox: null,
      reason: 'stale_provisioning_pending',
    });

    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(sessionSandboxRows).toHaveLength(0);
    expect(lastProvisionInput?.sandboxId).toBe(SESSION_ID);
  });

  test('dashboard start retires abandoned started provisioning rows and reallocates', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'provisioning',
      sandboxProvider: 'platinum',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'platinum',
        externalId: null,
        baseUrl: null,
        status: 'provisioning',
        config: {},
        metadata: {
          initStatus: 'provisioning',
          initAttempts: 1,
          initMaxAttempts: 3,
          initStartedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
          initUpdatedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
          healthStatus: 'unknown',
        },
        lastUsedAt: null,
        createdAt: new Date(Date.now() - 6 * 60 * 1000),
        updatedAt: new Date(Date.now() - 6 * 60 * 1000),
      },
    ];

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'provisioning',
      agent_name: 'default',
      retriable: true,
      sandbox: null,
      reason: 'stale_provisioning_lost',
    });

    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(sessionSandboxRows).toHaveLength(0);
    expect(lastProvisionInput?.sandboxId).toBe(SESSION_ID);
  });

  test('dashboard start of an existing sandbox wakes in place and never allocates a second runtime', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      sandboxProvider: 'daytona',
      status: 'running',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'daytona',
        externalId: 'box-existing',
        baseUrl: null,
        status: 'active',
        config: {},
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    providerStatus = 'stopped';

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'starting',
      agent_name: 'default',
      retriable: true,
    });
    expect(providerStartCalls).toBe(1);
    expect(sandboxProvisionCalls).toBe(0);
    expect(branchCreateCalls).toBe(0);
  });

  test('dashboard start does not expose a stale sandbox while the provider is waking', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      sandboxProvider: 'daytona',
      status: 'running',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'daytona',
        externalId: 'box-existing',
        baseUrl: null,
        status: 'active',
        config: {},
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    providerStatus = 'stopped';

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'starting',
      agent_name: 'default',
      retriable: true,
      sandbox: null,
      reason: 'runtime_waking',
    });
    expect(providerStartCalls).toBe(1);
    expect(sandboxProvisionCalls).toBe(0);
  });

  test('dashboard start preserves a sandbox that stayed stopped after wake grace', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      sandboxProvider: 'daytona',
      status: 'running',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'daytona',
        externalId: 'box-stuck-stopped',
        baseUrl: null,
        status: 'active',
        config: {},
        metadata: {
          runtimeWakeStartedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
          runtimeWakeProviderStatus: 'stopped',
        },
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    providerStatus = 'stopped';

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'failed',
      retriable: false,
      reason: 'runtime_identity_unavailable',
      sandbox: { external_id: 'box-stuck-stopped', status: 'stopped' },
    });

    expect(providerStartCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionSandboxRows).toHaveLength(1);
    expect(sessionSandboxRows[0]?.externalId).toBe('box-stuck-stopped');
  });

  test('dashboard start preserves an old active row whose provider status stays unknown', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      sandboxProvider: 'platinum',
      status: 'running',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'platinum',
        externalId: 'box-status-unknown',
        baseUrl: null,
        status: 'active',
        config: {},
        metadata: {
          initStatus: 'ready',
          initSucceededAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        },
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    providerStatus = 'unknown';

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'failed',
      retriable: false,
      reason: 'runtime_identity_unavailable',
      sandbox: { external_id: 'box-status-unknown', status: 'stopped' },
    });

    expect(providerStartCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionSandboxRows).toHaveLength(1);
    expect(sessionSandboxRows[0]?.externalId).toBe('box-status-unknown');
  });

  test('dashboard start gives a freshly-created active runtime grace when provider status is removed', async () => {
    const app = createApp();
    const initSucceededAt = new Date().toISOString();
    sessionRow = {
      ...sessionRow!,
      sandboxProvider: 'platinum',
      status: 'running',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'platinum',
        externalId: 'box-fresh-eventual-404',
        baseUrl: null,
        status: 'active',
        config: {},
        metadata: {
          initStatus: 'ready',
          initSucceededAt,
        },
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    providerStatus = 'removed';

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'starting',
      retriable: true,
      sandbox: null,
      reason: 'runtime_removed_checking',
    });

    expect(providerStartCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionSandboxRows).toHaveLength(1);
    expect(sessionSandboxRows[0]?.externalId).toBe('box-fresh-eventual-404');
    expect(
      (sessionSandboxRows[0]?.metadata as Record<string, unknown>).runtimeWakeStartedAt,
    ).toEqual(expect.any(String));
  });

  test('concurrent archived resume + transient removed status keeps the original identity fenced', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      sandboxProvider: 'daytona',
      status: 'stopped',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'daytona',
        externalId: 'box-original-archived',
        baseUrl: null,
        status: 'stopped',
        config: {},
        metadata: {
          initStatus: 'ready',
          initSucceededAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        },
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    providerStatus = 'removed';
    providerStartGate = new Promise<void>((resolve) => {
      releaseProviderStart = resolve;
    });

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'starting',
      retriable: true,
      reason: 'runtime_removed_checking',
    });
    expect(providerStartCalls).toBe(1);
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionSandboxRows).toHaveLength(1);
    expect(sessionSandboxRows[0]?.externalId).toBe('box-original-archived');
    expect(sessionSandboxRows[0]?.status).toBe('active');
    expect(
      (sessionSandboxRows[0]?.metadata as Record<string, unknown>).runtimeWakeStartedAt,
    ).toEqual(expect.any(String));
    releaseProviderStart?.();
  });

  test('dashboard start never replaces a provider-removed established sandbox', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      sandboxProvider: 'platinum',
      status: 'running',
      opencodeSessionId: 'ses_root_existing',
      metadata: {
        existing: true,
        initial_prompt: 'DO NOT REPLAY',
        opencode_model: 'anthropic/claude-sonnet-4-6',
      },
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'platinum',
        externalId: 'box-deleted',
        baseUrl: null,
        status: 'active',
        config: {},
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    providerStatus = 'removed';
    providerRecoveryEnabled = true;

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'failed',
      agent_name: 'default',
      retriable: false,
      reason: 'runtime_identity_unavailable',
      sandbox: { external_id: 'box-deleted', status: 'stopped' },
    });

    expect(providerStartCalls).toBe(0);
    expect(providerRecoveryCalls).toBe(1);
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionSandboxRows).toHaveLength(1);
    expect(sessionSandboxRows[0]).toMatchObject({
      externalId: 'box-deleted',
      status: 'stopped',
      metadata: {
        preservedExternalId: 'box-deleted',
        runtimeIdentityState: 'unavailable',
      },
    });
    expect(sessionRow?.status).toBe('stopped');
    expect(sessionRow?.opencodeSessionId).toBe('ses_root_existing');
  });

  test('dashboard start restores a provider-removed sandbox in place without provisioning', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'stopped',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'platinum',
        externalId: 'box-restorable',
        status: 'stopped',
        baseUrl: 'https://box-restorable.test',
        config: {},
        metadata: { providerStatusObservedAt: '2026-01-01T00:00:00.000Z' },
        lastUsedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    providerStatus = 'removed';
    providerRecoveryEnabled = true;
    providerRecoveryStatus = 'recovering';

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'starting',
      reason: 'runtime_restoring_in_place',
      sandbox: { external_id: 'box-restorable' },
      opencode_session_id: 'ses_root_existing',
    });
    expect(providerRecoveryCalls).toBe(1);
    expect(providerStartCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionSandboxRows[0]?.externalId).toBe('box-restorable');
    expect(sessionSandboxRows[0]?.status).toBe('provisioning');
    expect(computeReopenCalls).toBe(0);

    providerStatus = 'running';
    const ready = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      stage: 'ready',
      sandbox: { external_id: 'box-restorable', status: 'active' },
      opencode_session_id: 'ses_root_existing',
    });
    expect(providerRecoveryCalls).toBe(1);
    expect(sessionSandboxRows[0]?.status).toBe('active');
    expect(sessionRow?.status).toBe('running');
    expect(computeReopenCalls).toBe(1);
  });

  test('concurrent dashboard starts issue exactly one same-id provider recovery', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'running',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'platinum',
        externalId: 'box-single-flight',
        status: 'active',
        baseUrl: 'https://box-single-flight.test',
        config: {},
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    providerStatus = 'removed';
    providerRecoveryEnabled = true;
    providerRecoveryStatus = 'recovering';
    providerRecoveryGate = new Promise<void>((resolve) => {
      releaseProviderRecovery = resolve;
    });

    const first = app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    await flushUntil(() => providerRecoveryCalls === 1);
    const second = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      stage: 'starting',
      reason: 'runtime_recovery_in_progress',
      sandbox: { external_id: 'box-single-flight' },
    });
    expect(providerRecoveryCalls).toBe(1);
    expect(sandboxProvisionCalls).toBe(0);

    releaseProviderRecovery?.();
    expect(await (await first).json()).toMatchObject({
      stage: 'starting',
      reason: 'runtime_restoring_in_place',
    });
    expect(providerRecoveryCalls).toBe(1);
  });

  test('explicit deletion winning during recovery prevents status and billing resurrection', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'running',
        opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'platinum',
        externalId: 'box-delete-race',
        status: 'active',
        baseUrl: 'https://box-delete-race.test',
        config: {},
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    providerStatus = 'removed';
    providerRecoveryEnabled = true;
    providerRecoveryStatus = 'running';
    providerRecoveryGate = new Promise<void>((resolve) => {
      releaseProviderRecovery = resolve;
    });

    const request = app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    await flushUntil(() => providerRecoveryCalls === 1);
    sessionRow = {
      ...sessionRow!,
      status: 'stopped',
      metadata: {
        ...(sessionRow?.metadata ?? {}),
        deletedAt: new Date().toISOString(),
      },
    };
    sessionSandboxRows[0] = { ...sessionSandboxRows[0]!, status: 'archived' };
    releaseProviderRecovery?.();

    const res = await request;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'stopped',
      retriable: false,
      reason: 'runtime_recovery_cancelled',
    });
    expect(sessionRow?.status).toBe('stopped');
    expect(sessionSandboxRows[0]?.status).toBe('archived');
    expect(computeReopenCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
  });

  test('dashboard start preserves a running sandbox whose OpenCode runtime never becomes reachable', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      sandboxProvider: 'platinum',
      status: 'running',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'platinum',
        externalId: 'box-opencode-dead',
        baseUrl: null,
        status: 'active',
        config: {},
        metadata: {
          initStatus: 'ready',
          initSucceededAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
          opencodeReadyWaitStartedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
          opencodeReadyWaitReason: 'unreachable',
        },
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    providerStatus = 'running';
    opencodeEnsureReason = 'unreachable';

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'failed',
      retriable: false,
      reason: 'runtime_identity_unavailable',
      sandbox: { external_id: 'box-opencode-dead', status: 'stopped' },
    });

    expect(providerStartCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionSandboxRows).toHaveLength(1);
    expect(sessionSandboxRows[0]?.externalId).toBe('box-opencode-dead');
  });

  test('restart of a provider-removed sandbox refuses replacement and preserves identity', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      sandboxProvider: 'platinum',
      status: 'running',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'platinum',
        externalId: 'box-deleted',
        baseUrl: null,
        status: 'active',
        config: {},
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    providerStatus = 'removed';
    providerRecoveryEnabled = true;

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/restart`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'SESSION_RUNTIME_IDENTITY_UNAVAILABLE',
      session_id: SESSION_ID,
      external_id: 'box-deleted',
      reason: 'runtime_identity_unavailable',
    });

    expect(providerStartCalls).toBe(0);
    expect(providerRecoveryCalls).toBe(1);
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionRow?.status).toBe('stopped');
    expect(sessionSandboxRows).toHaveLength(1);
    expect(sessionSandboxRows[0]).toMatchObject({
      externalId: 'box-deleted',
      status: 'stopped',
      metadata: {
        preservedExternalId: 'box-deleted',
        runtimeIdentityState: 'unavailable',
      },
    });
  });

  test('restart restores a provider-removed sandbox in place without provisioning', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'stopped',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'platinum',
        externalId: 'box-restart-restorable',
        status: 'stopped',
        baseUrl: 'https://box-restart-restorable.test',
        config: {},
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    providerStatus = 'removed';
    providerRecoveryEnabled = true;
    providerRecoveryStatus = 'recovering';

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/restart`, {
      method: 'POST',
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      ok: true,
      session_id: SESSION_ID,
      status: 'provisioning',
      reason: 'runtime_restoring_in_place',
    });
    expect(providerRecoveryCalls).toBe(1);
    expect(providerStartCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionSandboxRows[0]).toMatchObject({
      externalId: 'box-restart-restorable',
      status: 'provisioning',
    });
    expect(sessionRow).toMatchObject({
      status: 'provisioning',
      opencodeSessionId: 'ses_root_existing',
    });
  });

  test('restart preserves identity when provider status is uncertain and start returns not-found', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'running',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'daytona',
        externalId: 'box-missing-on-start',
        baseUrl: null,
        status: 'active',
        config: {},
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    providerStatus = 'unknown';
    providerStartError = Object.assign(new Error('sandbox not found'), {
      status: 404,
    });

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/restart`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    await flushUntil(() => sessionRow?.status === 'stopped');
    expect(providerStartCalls).toBe(1);
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionSandboxRows[0]).toMatchObject({
        externalId: 'box-missing-on-start',
      status: 'stopped',
      metadata: { preservedExternalId: 'box-missing-on-start' },
    });
  });

  test('restart preserves identity when provider accepts start but then reports removed', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'running',
      opencodeSessionId: 'ses_root_existing',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        provider: 'platinum',
        externalId: 'box-accepted-start-then-removed',
        baseUrl: null,
        status: 'active',
        config: {},
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    providerStatus = 'unknown';
    providerStatusAfterStart = 'removed';

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/restart`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    await flushUntil(() => sessionRow?.status === 'stopped');
    expect(providerStartCalls).toBe(1);
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionSandboxRows[0]).toMatchObject({
        externalId: 'box-accepted-start-then-removed',
      status: 'stopped',
      metadata: { preservedExternalId: 'box-accepted-start-then-removed' },
    });
  });

  test('dashboard start recovery of an already-bootstrapped session provisions without replaying the initial prompt', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      sandboxProvider: 'daytona',
      status: 'running',
      opencodeSessionId: 'ses_root_existing',
      metadata: {
        existing: true,
        initial_prompt: 'DO NOT REPLAY',
        opencode_model: 'anthropic/claude-sonnet-4-6',
      },
    };
    sessionSandboxRows = [];

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'provisioning',
      retriable: true,
    });

    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(sandboxProvisionCalls).toBe(1);
    expect(branchCreateCalls).toBe(0);
    expect(lastProvisionInput?.sandboxId).toBe(SESSION_ID);
    const env = lastProvisionInput?.extraEnvVars ?? {};
    expect(env.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBe('1');
    expect(env.KORTIX_INITIAL_PROMPT).toBeUndefined();
    expect(env.KORTIX_OPENCODE_MODEL).toBe('anthropic/claude-sonnet-4-6');
  });

  test('allows only user-owned PATCH fields', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Human name',
          metadata: { custom: 'ok' },
        }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Human name');
    expect(body.opencode_session_id).toBeNull();
    expect(body.status).toBe('provisioning');
    expect(body.metadata).toEqual({
      existing: true,
      custom: 'ok',
      custom_name: 'Human name',
    });
  });

  test('rejects unknown providers before creating a git branch', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'justavps' }),
    });

    expect(res.status).toBe(400);
    expect(branchCreateCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // End-to-end: stored project secrets must land in the sandbox env at session
  // create. This is the contract the entire Secrets Manager UX relies on —
  // anything stored via POST /secrets is expected to be a plain env var at
  // sandbox boot, alongside the platform-managed KORTIX_* envelope.
  // ---------------------------------------------------------------------------
  test('e2e: stored project secrets are injected as plaintext env vars at session create', async () => {
    const app = createApp();

    // 1. User stores two secrets via the Secrets Manager.
    for (const [name, value] of [
      ['OPENAI_API_KEY', 'sk-test-openai'],
      ['STRIPE_SECRET', 'sk_test_stripe_live'],
    ] as const) {
      const writeRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value }),
      });
      expect(writeRes.status).toBe(200);
    }
    expect(secretRows).toHaveLength(2);
    // Stored values are encrypted at rest — plaintext never appears in valueEnc.
    for (const row of secretRows) {
      expect(row.valueEnc).not.toContain('sk-test-openai');
      expect(row.valueEnc).not.toContain('sk_test_stripe_live');
    }

    // 2. User creates a session — sandbox provisioning is fire-and-forget.
    const createRes = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'daytona', base_ref: 'main' }),
    });
    expect(createRes.status).toBe(201);

    // 3. Flush the fire-and-forget IIFE that calls provisionSessionSandbox.
    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionInput).not.toBeNull();

    // 4. User secrets are present, decrypted, in extraEnvVars.
    const env = lastProvisionInput!.extraEnvVars ?? {};
    expect(env.OPENAI_API_KEY).toBe('sk-test-openai');
    expect(env.STRIPE_SECRET).toBe('sk_test_stripe_live');

    // 5. Platform KORTIX_* envelope is still present alongside user secrets.
    // Git provider credentials are deliberately absent; provisionSessionSandbox
    // injects the single sandbox KORTIX_TOKEN at the provider boundary.
    expect(env.KORTIX_PROJECT_ID).toBe(PROJECT_ID);
    expect(env.KORTIX_SESSION_ID).toBeTruthy();
    const expectedRepoUrl =
      process.env.KORTIX_GIT_PROXY === 'true'
        ? new URL(
            `/v1/git/${PROJECT_ID}.git`,
            process.env.KORTIX_URL ?? 'https://test.kortix.local',
          ).toString()
        : projectRow.repoUrl;
    expect(env.KORTIX_REPO_URL).toBe(expectedRepoUrl);
    expect(env.KORTIX_BASE_REF).toBe('main');
    // LLM/tool-router URLs are no longer injected — the sandbox derives any
    // router endpoint it needs from KORTIX_API_URL.
    expect(env.KORTIX_LLM_TOKEN).toBeUndefined();
    expect(env.KORTIX_LLM_BASE_URL).toBeUndefined();
    expect(env.TAVILY_API_URL).toBeUndefined();
    expect(env.KORTIX_CLI_TOKEN).toBeUndefined();
    expect(env.KORTIX_TOKEN).toBeUndefined();
    expect(env.KORTIX_API_URL).toBeTruthy();
    expect(env.KORTIX_GIT_AUTH_TOKEN).toBeUndefined();
    expect(env.KORTIX_GITHUB_TOKEN).toBeUndefined();
    expect(env.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBe('1');
    expect(env.KORTIX_INITIAL_PROMPT).toBeUndefined();

    // 6. User can't shadow a platform var — POST /secrets rejects KORTIX_*.
    // This protects the env-var precedence: user secrets are merged before
    // KORTIX_* in the helper, so an accepted KORTIX_TOKEN would silently
    // poison the sandbox auth.
    const shadowRes = await app.request(`/v1/projects/${PROJECT_ID}/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'KORTIX_TOKEN', value: 'phishy' }),
    });
    expect(shadowRes.status).toBe(400);
  });

  test('creates a session with the required id, branch, and sandbox invariant', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        name: 'Contract session',
        agent_name: 'reviewer',
        initial_prompt: 'Review the repo',
      }),
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    const body = await res.json();
    expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.session_id).toBe(body.sandbox_id);
    expect(body.session_id).toBe(body.branch_name);
    expect(body.sandbox_provider).toBe('daytona');
    expect(body.status).toBe('provisioning');
    expect(body.name).toBe('Contract session');
    expect(branchCreateCalls).toBe(1);

    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionInput!.extraEnvVars?.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBe('1');
    expect(lastProvisionInput!.extraEnvVars?.KORTIX_INITIAL_PROMPT).toBe('Review the repo');
  });

  test('persists runtime_context separately and injects one server-owned JSON envelope', async () => {
    const app = createApp();
    const runtimeContext = {
      workspace_id: 'veyris_org_123',
      'wrapper.locale': 'de',
      licensed: true,
      risk_score: 0.25,
      optional: null,
    };
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtime_context: runtimeContext }),
    });

    expect(res.status).toBe(201);
    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(runtimeContextRows).toHaveLength(1);
    expect(runtimeContextRows[0]?.context).toEqual(runtimeContext);
    expect(runtimeContextRows[0]?.byteSize).toBe(
      new TextEncoder().encode(JSON.stringify(runtimeContext)).byteLength,
    );
    expect(sessionRow?.metadata).not.toHaveProperty('runtime_context');
    const env = lastProvisionInput?.extraEnvVars ?? {};
    expect(JSON.parse(env.KORTIX_SESSION_CONTEXT!)).toEqual(runtimeContext);
    expect(env).not.toHaveProperty('workspace_id');
    expect(env).not.toHaveProperty('VEYRIS_WORKSPACE_ID');
  });

  test('rejects invalid runtime_context before persisting or provisioning a session', async () => {
    const app = createApp();
    for (const runtimeContext of [
      { KORTIX_TOKEN: 'shadow' },
      { workspace_id: { nested: true } },
      { payload: 'é'.repeat(9_000) },
    ]) {
      sessionRow = null;
      const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime_context: runtimeContext }),
      });
      expect(res.status).toBe(400);
      expect(sessionRow).toBeNull();
      expect(runtimeContextRows).toHaveLength(0);
      expect(sandboxProvisionCalls).toBe(0);
    }
  });

  test('rejects unknown session-create fields at the HTTP boundary', async () => {
    const app = createApp();
    sessionRow = null;

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initial_prompt: 'noop', arbitrary_env: 'nope' }),
    });

    expect(res.status).toBe(400);
    expect(sessionRow).toBeNull();
    expect(runtimeContextRows).toHaveLength(0);
    expect(sandboxProvisionCalls).toBe(0);
  });

  test('cold /start restores durable runtime_context into a replacement runtime', async () => {
    const app = createApp();
    const context = { workspace_id: 'veyris_org_cold', locale: 'fr' };
    runtimeContextRows = [
      {
      sessionId: SESSION_ID,
      context,
      byteSize: new TextEncoder().encode(JSON.stringify(context)).byteLength,
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    sessionRow = {
      ...sessionRow!,
      status: 'running',
      opencodeSessionId: 'ses_existing',
    };
    sessionSandboxRows = [];

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(JSON.parse(lastProvisionInput!.extraEnvVars!.KORTIX_SESSION_CONTEXT!)).toEqual(context);
  });

  test('replacement restart restores durable runtime_context', async () => {
    const app = createApp();
    const context = { workspace_id: 'veyris_org_restart', locale: 'en' };
    runtimeContextRows = [
      {
      sessionId: SESSION_ID,
      context,
      byteSize: new TextEncoder().encode(JSON.stringify(context)).byteLength,
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    sessionRow = {
      ...sessionRow!,
      status: 'running',
      opencodeSessionId: 'ses_existing',
    };
    sessionSandboxRows = [];

    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/restart`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(JSON.parse(lastProvisionInput!.extraEnvVars!.KORTIX_SESSION_CONTEXT!)).toEqual(context);
  });

  test('accepts a client-created session branch without recreating it server-side', async () => {
    const app = createApp();
    const clientSessionId = '11111111-1111-4111-a111-111111111111';
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: clientSessionId,
        branch_already_created: true,
        base_ref: 'main',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session_id).toBe(clientSessionId);
    expect(body.branch_name).toBe(clientSessionId);
    expect(branchCreateCalls).toBe(0);

    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(sandboxProvisionCalls).toBe(1);
  });

  test('stops a session without deleting its preserved branch row', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`, {
        method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sessionRow?.status).toBe('stopped');
    expect(sessionRow?.branchName).toBe(SESSION_ID);

    sessionRow = null;
    const missing = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`, {
        method: 'DELETE',
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'Not found' });
  });

  test('rejects concurrent session cap before creating a git branch', async () => {
    activeSessionCount = 1;
    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'daytona' }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(await res.json()).toMatchObject({
      code: 'concurrent_session_limit',
      limit: 1,
      active_sessions: 1,
    });
    expect(branchCreateCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
  });
});
