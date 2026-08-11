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
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { SandboxRuntimeHealth } from '../workspaces/runtime-inspection';
import { mockIamEngineAllowAll, mockIamMembershipSyncNoop } from './helpers/iam-mocks';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const WORKSPACE_ID = '00000000-0000-4000-a000-000000000201';
const SESSION_ID = '00000000-0000-4000-a000-000000000301';
const TEST_GITHUB_OWNER = 'kortix-org';
const WORKSPACE_RUNTIME_PAT = 'kortix_pat_project_runtime';
const SESSION_AGENT_PAT = 'kortix_pat_session_agent';
const WORKSPACE_SANDBOX_TOKEN = 'kortix_sb_project_runtime';
const WORKSPACE_SA_TOKEN = 'kortix_sa_backend_wrapper';
const SESSION_BOUND_PAT = 'kortix_pat_session_connector';
const ORIGINAL_KORTIX_GITHUB_OWNER = process.env.KORTIX_GITHUB_OWNER;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;
const ORIGINAL_KORTIX_URL = process.env.KORTIX_URL;
const ORIGINAL_ALLOWED_SANDBOX_PROVIDERS = process.env.ALLOWED_SANDBOX_PROVIDERS;

process.env.KORTIX_GITHUB_OWNER = TEST_GITHUB_OWNER;
process.env.API_KEY_SECRET = 'test-project-secret-key-material-32-bytes';
process.env.KORTIX_URL = 'https://api.test.kortix.local';
process.env.ALLOWED_SANDBOX_PROVIDERS = 'daytona,platinum,e2b';

const { config } = await import('../config');

let branchCreateCalls = 0;
let sandboxProvisionCalls = 0;
let providerStartCalls = 0;
let providerStopCalls = 0;
let providerStatus = 'stopped';
let providerStatusSequence: string[] = [];
let providerStatusAfterStart: string | null = null;
let providerStatusSessionMetadataUpdate: Record<string, unknown> | null = null;
let providerStartError: Error | null = null;
let providerStartGate: Promise<void> | null = null;
let releaseProviderStart: (() => void) | null = null;
let runtimeInspectionHealth: SandboxRuntimeHealth | null = null;
let providerRecoveryCalls = 0;
let providerRecoveryEnabled = false;
let providerRecoveryStatus: 'running' | 'recovering' | 'unavailable' = 'unavailable';
let providerRecoveryGate: Promise<void> | null = null;
let releaseProviderRecovery: (() => void) | null = null;
let computeReopenCalls = 0;
let opencodeEnsureReason: 'unchanged' | 'healed' | 'not_ready' | 'unreachable' = 'unchanged';
let activeSessionCount = 0;
let sessionRow: typeof projectSessions.$inferSelect | null;
let lastSessionInsertValues: Record<string, unknown> | null = null;
let lastSessionListWhere: unknown = null;
// `active_since` / `deadline_at` are assigned by a DB trigger, never by
// application code, so these HTTP-contract fixtures deliberately omit them —
// none of the routes under test reads either column (only the reaper does, and
// it has its own suite).
type SandboxRowFixture = Omit<typeof sessionSandboxes.$inferSelect, 'activeSince' | 'deadlineAt'> &
  Partial<Pick<typeof sessionSandboxes.$inferSelect, 'activeSince' | 'deadlineAt'>>;
let sessionSandboxRows: Array<SandboxRowFixture>;
let secretRows: Array<typeof projectSecrets.$inferSelect>;
let runtimeContextRows: Array<typeof projectSessionRuntimeContexts.$inferSelect>;
let secretValues: Map<string, string>;
let gitConnectionRows: Array<typeof projectGitConnections.$inferSelect>;
let gitCredentialRows: Array<typeof projectGitCredentials.$inferSelect>;
let assertedIamActions: string[] = [];
let deniedIamAction: string | null = null;
let lastProvisionInput: {
  sandboxId: string;
  accountId: string;
  workspaceId: string;
  userId: string;
  provider?: string;
  extraEnvVars?: Record<string, string>;
  metadata?: Record<string, unknown>;
} | null = null;

const projectRow: typeof projects.$inferSelect = {
  workspaceId: WORKSPACE_ID,
  accountId: ACCOUNT_ID,
  sandboxProviderGeneration: 0,
  secretDefaultStrategy: 'runtime' as const,
  name: 'Contract Workspace',
  repoUrl: `https://github.com/${TEST_GITHUB_OWNER}/contract-project.git`,
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  idempotencyKey: null,
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
  providerStopCalls = 0;
  providerStatus = 'stopped';
  providerStatusSequence = [];
  providerStatusAfterStart = null;
  providerStatusSessionMetadataUpdate = null;
  providerStartError = null;
  providerStartGate = null;
  releaseProviderStart = null;
  runtimeInspectionHealth = null;
  providerRecoveryCalls = 0;
  providerRecoveryEnabled = false;
  providerRecoveryStatus = 'unavailable';
  providerRecoveryGate = null;
  releaseProviderRecovery = null;
  computeReopenCalls = 0;
  opencodeEnsureReason = 'unchanged';
  activeSessionCount = 0;
  lastSessionInsertValues = null;
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
    workspaceId: WORKSPACE_ID,
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
    origin: 'user',
    originRef: null,
    secretsAllowlist: null,
    requiredConnectors: null,
    connectorBindingsInheritUnbound: false,
    connectorBindingsConfigured: false,
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
  assertedIamActions = [];
  deniedIamAction = null;
}

const realAuthMiddleware = await import('../middleware/auth');
mock.module('../middleware/auth', () => ({
  ...realAuthMiddleware,
  supabaseAuth: async (c: any, next: any) => {
    if (c.req.header('Authorization') === `Bearer ${WORKSPACE_SANDBOX_TOKEN}`) {
      c.set('userId', ACCOUNT_ID);
      c.set('userEmail', '');
      c.set('authType', 'apiKey');
      c.set('apiKeyType', 'sandbox');
      c.set('accountId', ACCOUNT_ID);
      c.set('sandboxId', SESSION_ID);
      await next();
      return;
    }
    if (c.req.header('Authorization') === `Bearer ${WORKSPACE_RUNTIME_PAT}`) {
      c.set('userId', USER_ID);
      c.set('userEmail', '');
      c.set('authType', 'pat');
      c.set('accountId', ACCOUNT_ID);
      c.set('tokenWorkspaceId', WORKSPACE_ID);
      c.set('iamTokenId', '00000000-0000-4000-a000-000000000901');
      await next();
      return;
    }
    if (c.req.header('Authorization') === `Bearer ${SESSION_AGENT_PAT}`) {
      c.set('userId', USER_ID);
      c.set('userEmail', '');
      c.set('authType', 'pat');
      c.set('accountId', ACCOUNT_ID);
      c.set('tokenWorkspaceId', WORKSPACE_ID);
      c.set('sessionId', SESSION_ID);
      c.set('iamTokenId', '00000000-0000-4000-a000-000000000903');
      c.set('agentGrant', {
        agent: 'contract-agent',
        connectors: 'all',
        kortixCli: 'all',
        env: 'all',
      });
      await next();
      return;
    }
    if (c.req.header('Authorization') === `Bearer ${SESSION_BOUND_PAT}`) {
      c.set('userId', USER_ID);
      c.set('userEmail', '');
      c.set('authType', 'pat');
      c.set('accountId', ACCOUNT_ID);
      c.set('tokenWorkspaceId', WORKSPACE_ID);
      c.set('sessionId', SESSION_ID);
      c.set('iamTokenId', '00000000-0000-4000-a000-000000000903');
      await next();
      return;
    }
    if (c.req.header('Authorization') === `Bearer ${WORKSPACE_SA_TOKEN}`) {
      c.set('userId', USER_ID);
      c.set('userEmail', '');
      c.set('authType', 'service_account');
      c.set('accountId', ACCOUNT_ID);
      c.set('tokenWorkspaceId', WORKSPACE_ID);
      c.set('iamTokenId', '00000000-0000-4000-a000-000000000902');
      await next();
      return;
    }
    c.set('userId', USER_ID);
    c.set('userEmail', 'contract@example.test');
    c.set('authType', 'supabase');
    // The real middleware sets `sessionId` to the SUPABASE AUTH session for
    // browser JWTs (IAM idle/lifetime gate) — it is NOT a project session.
    // Mirrored here so a caller-session consumer that forgets to filter by
    // authType (callerKortixSessionId) fails a test instead of stamping
    // login-session ids into project data.
    c.set('sessionId', '00000000-0000-4000-a000-00000000auth');
    await next();
  },
}));

mock.module('../workspaces/git', () => ({
  MergeConflictError: class MergeConflictError extends Error {},
  createRemoteSessionBranch: async () => {
    branchCreateCalls += 1;
  },
  remoteBranchExists: async () => true,
  archiveRepoSubtree: async () => undefined,
  deleteRemoteSessionBranch: async () => undefined,
  listRepoFiles: async () => [],
  searchRepoFileNames: async () => [],
  grepRepoFiles: async () => [],
  loadWorkspaceConfig: async () => ({}),
  readRepoFile: async () => '',
  // connector/sync.ts imports these from the same barrel; a wholesale module mock
  // that omits them makes the whole file fail to LOAD with a SyntaxError, which
  // reads as "the suite is broken" rather than "the mock is short two names".
  RepoFileNotFoundError: class RepoFileNotFoundError extends Error {},
  isRepoFileNotFoundError: () => false,
  // compile-agent-config.ts (the agent-first v2 compiler) reads the manifest
  // straight from git — no manifest ⇒ null ⇒ the v1-shaped projects this suite
  // exercises get no compiled agent config, matching their pre-compiler behavior.
  readManifestFromRepo: async () => null,
  invalidateWorkspaceMirror: () => {},
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
  ensureMetaSandboxImage: async () => ({
    snapshotName: 'kortix-meta-test',
    slug: 'meta',
    contentHash: 'b'.repeat(64),
    built: false,
    isDefault: false,
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
  kickRoutedPreBuild: () => {},
  templateBuildProviders: () => ['daytona', 'platinum', 'e2b'],
  kickWorkspaceTemplatePrebuilds: () => {},
  kickStartupPreBuild: () => {},
  reconcileWorkspaceTemplates: async () => undefined,
  reconcileStaleBuilds: async () => undefined,
  ensurePlatformDefaultImage: async () => undefined,
  resolveCommitSha: async () => 'a'.repeat(40),
  ensurePerWorkspaceWarmImage: async () => ({
    snapshotName: 'kortix-ppwarm-test',
    tip: 'a'.repeat(40),
    built: false,
    provider: 'daytona',
  }),
  DEFAULT_SANDBOX_SLUG: 'default',
}));

mock.module('../workspaces/github', () => ({
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
  verifyGitHubInstallationAdmin: async () => undefined,
  listLinkableGitHubAppInstallations: async () => [],
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
  getRepositoryBranch: async ({ branch }: { branch: string }) => ({
    name: branch,
    protected: false,
  }),
  listInstallationRepositories: async () => [],
  listOwnerRepositories: async () => [],
  listRepositoryBranches: async () => [],
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

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
// `await import`, not a top-level `import`: the latter hoists above the
// process.env writes here, and the barrel pulls in config, which reads them once.
const realProviders = await import('../platform/providers');
mock.module('../platform/providers', () => ({
  ...realProviders,
  WarmRuntimeUnavailableError: class WarmRuntimeUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WarmRuntimeUnavailableError';
    }
  },
  getProvider: () => ({
    getStatus: async () => {
      if (providerStatusSessionMetadataUpdate && sessionRow) {
        sessionRow = {
          ...sessionRow,
          metadata: {
            ...(sessionRow.metadata ?? {}),
            ...providerStatusSessionMetadataUpdate,
          },
        };
      }
      return providerStatusSequence.shift() ?? providerStatus;
    },
    start: async () => {
      providerStartCalls += 1;
      if (providerStartError) throw providerStartError;
      if (providerStatusAfterStart) providerStatus = providerStatusAfterStart;
      if (providerStartGate) await providerStartGate;
    },
    stop: async () => {
      providerStopCalls += 1;
    },
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

const realRuntimeInspection = await import('../workspaces/runtime-inspection');
mock.module('../workspaces/runtime-inspection', () => ({
  ...realRuntimeInspection,
  inspectSandboxRuntime: async () => runtimeInspectionHealth,
}));

mock.module('../workspaces/opencode-mapping', () => ({
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

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
const realComputeMetering = await import('../billing/services/compute-metering');
mock.module('../billing/services/compute-metering', () => ({
  ...realComputeMetering,
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

mockIamEngineAllowAll((action) => {
  assertedIamActions.push(action);
  if (action === deniedIamAction) {
    throw new HTTPException(403, { message: `Denied ${action}` });
  }
});

mockIamMembershipSyncNoop();

mock.module('../repositories/account-tokens', () => ({
  createAccountToken: async () => ({ secretKey: WORKSPACE_RUNTIME_PAT }),
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
  maxWorkspacesForAccount: async () => 100,
  accountEntitledToLlmGateway: async () => true,
  FREE_TIER_WORKSPACE_LIMIT: 1,
  clearAccountLimitCache: () => undefined,
}));

const realDefaultModelResolution = await import('../llm-gateway/resolution/default-model');
mock.module('../llm-gateway/resolution/default-model', () => ({
  ...realDefaultModelResolution,
  isModelServableForAccount: async () => true,
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

function applySandboxUpdates(
  row: SandboxRowFixture,
  updates: Partial<typeof sessionSandboxes.$inferSelect>,
): SandboxRowFixture {
  let metadata = updates.metadata;
  if (metadata && typeof metadata === 'object' && 'queryChunks' in metadata) {
    const query = new PgDialect().sqlToQuery(metadata as unknown as SQL);
    const merged = { ...((row.metadata ?? {}) as Record<string, unknown>) };
    for (const key of query.sql.matchAll(/- '([^']+)'/g)) delete merged[key[1]!];
    for (const param of query.params) {
      if (typeof param !== 'string' || !param.startsWith('{')) continue;
      try {
        Object.assign(merged, JSON.parse(param) as Record<string, unknown>);
      } catch {
        // Non-JSON SQL parameters are unrelated to metadata merges.
      }
    }
    metadata = merged;
  }
  return {
    ...row,
    ...updates,
    metadata: metadata === undefined ? row.metadata : metadata,
    updatedAt: updates.updatedAt ?? new Date('2026-01-02T00:00:00Z'),
  };
}

mock.module('../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    transaction: async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn(this);
    },
    execute: async () => [],
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (predicate?: unknown) => ({
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => {
            Promise.resolve(table === projectSecrets ? secretRows : []).then(resolve, reject);
          },
          orderBy: async () => {
            if (table === projectSecrets) return secretRows;
            if (table === projectSessions) {
              // Recorded so a test can assert WHICH predicate the list route
              // built. This mock returns rows regardless of the filter, so
              // asserting on the response alone would pass even if the filter
              // were never applied.
              lastSessionListWhere = predicate ?? null;
              return sessionRow ? [sessionRow] : [];
            }
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
            if (table === projectSessions && fields?.sessionMetadata) {
              return sessionRow ? [{ sessionMetadata: sessionRow.metadata }] : [];
            }
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
              (row) => row.workspaceId === values.workspaceId,
            );
            const now = new Date('2026-01-02T00:00:00Z');
            const row = {
              connectionId:
                existingIndex >= 0
                  ? gitConnectionRows[existingIndex]!.connectionId
                  : '00000000-0000-4000-a000-000000000501',
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
              (row) => row.workspaceId === values.workspaceId && row.provider === values.provider,
            );
            const now = new Date('2026-01-02T00:00:00Z');
            const row = {
              credentialId:
                existingIndex >= 0
                  ? gitCredentialRows[existingIndex]!.credentialId
                  : '00000000-0000-4000-a000-000000000601',
              accountId: values.accountId,
              workspaceId: values.workspaceId,
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
          lastSessionInsertValues = values;
          sessionRow = {
            sessionId: values.sessionId,
            accountId: values.accountId,
            workspaceId: values.workspaceId,
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
            origin: values.origin ?? 'user',
            originRef: values.originRef ?? null,
            secretsAllowlist: values.secretsAllowlist ?? null,
            requiredConnectors: null,
            connectorBindingsInheritUnbound: values.connectorBindingsInheritUnbound ?? false,
            connectorBindingsConfigured: values.connectorBindingsConfigured ?? false,
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
                  (row) => row.workspaceId === values.workspaceId,
                );
                const now = new Date('2026-01-02T00:00:00Z');
                const row = {
                  connectionId:
                    existingIndex >= 0
                      ? gitConnectionRows[existingIndex]!.connectionId
                      : '00000000-0000-4000-a000-000000000501',
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
                  (row) => row.workspaceId === values.workspaceId && row.provider === values.provider,
                );
                const now = new Date('2026-01-02T00:00:00Z');
                const row = {
                  credentialId:
                    existingIndex >= 0
                      ? gitCredentialRows[existingIndex]!.credentialId
                      : '00000000-0000-4000-a000-000000000601',
                  accountId: values.accountId,
                  workspaceId: values.workspaceId,
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
                (row) => row.workspaceId === values.workspaceId && row.name === values.name,
              );
              const now = new Date('2026-01-02T00:00:00Z');
              const row: typeof projectSecrets.$inferSelect = {
                secretId:
                  existingIndex >= 0
                    ? secretRows[existingIndex]!.secretId
                    : '00000000-0000-4000-a000-000000000401',
                workspaceId: values.workspaceId!,
                identifier: values.identifier ?? values.name!,
                name: values.name!,
                valueEnc: (set.valueEnc ?? values.valueEnc)!,
                scope: values.scope ?? 'runtime',
                ownerUserId: values.ownerUserId ?? null,
                active: values.active ?? true,
                createdBy: values.createdBy ?? null,
                description: values.description ?? null,
                strategy: values.strategy ?? 'runtime',
                consumer: values.consumer ?? 'sandbox',
                egressPolicy: values.egressPolicy ?? null,
                handlePrefix: values.handlePrefix ?? null,
                rotatedAt: values.rotatedAt ?? null,
                strategyLocked: values.strategyLocked ?? false,
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
        where: (predicate?: unknown) => ({
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
              if (predicate) {
                const query = new PgDialect().sqlToQuery(predicate as SQL);
                const metadata = (row.metadata ?? {}) as Record<string, unknown>;
                if (
                  query.sql.includes('runtimeWakeRetryAfterAt') &&
                  typeof metadata.runtimeWakeId === 'string' &&
                  Date.parse(String(metadata.runtimeWakeLeaseExpiresAt)) > Date.now()
                ) {
                  return [];
                }
                if (query.sql.includes("->>'runtimeWakeId' =")) {
                  const wakeId = (row.metadata as Record<string, unknown> | null)?.runtimeWakeId;
                  if (typeof wakeId !== 'string' || !query.params.includes(wakeId)) return [];
                }
              }
              sessionSandboxRows[0] = applySandboxUpdates(row, updates);
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
                  sessionSandboxRows[0] = applySandboxUpdates(row, updates);
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
                sessionSandboxRows[0] = applySandboxUpdates(row, updates);
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
const { workspacesApp } = await import('../workspaces/index');
const { encryptWorkspaceSecret } = await import('../workspaces/secrets');
const { resumeStoppedSandbox } = await import('../workspaces/routes/shared');
const { applyStoppedState, reconcileSandboxStoppedByExternalId } = await import(
  '../workspaces/reaping/sandbox-state-sync'
);

function createApp() {
  const app = new Hono();
  app.route('/v1/projects', projectsApp);
  app.route('/v1/workspaces', workspacesApp);
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
    if (ORIGINAL_ALLOWED_SANDBOX_PROVIDERS === undefined) {
      delete process.env.ALLOWED_SANDBOX_PROVIDERS;
    } else {
      process.env.ALLOWED_SANDBOX_PROVIDERS = ORIGINAL_ALLOWED_SANDBOX_PROVIDERS;
    }
  });

  beforeEach(() => resetState());

  // The platform coordinator is a per-project experimental opt-in. Every other
  // test in this file runs with the flag OFF and asserts the pre-meta default
  // behavior byte-for-byte.
  function enableMetaAgent() {
    projectRow.metadata = {
      ...(projectRow.metadata as Record<string, unknown>),
      experimental: { meta_agent: true },
    };
  }

  test('creates an omitted-agent session with the meta REST runtime', async () => {
    enableMetaAgent();
    const app = createApp();
    const response = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'daytona', base_ref: 'main' }),
    });

    expect(response.status).toBe(201);
    const createdMeta = await response.json();
    expect(createdMeta).toMatchObject({
      agent_name: 'meta',
      metadata: {
        sandbox_slug: 'meta',
      },
    });
    // A browser (supabase) create is not an in-session spawn — its Supabase
    // AUTH session id must never be stamped as a coordinator link.
    expect(createdMeta.metadata?.spawned_by_session).toBeUndefined();
    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(lastProvisionInput).toMatchObject({
      agentName: 'meta',
      sandboxSlug: 'meta',
      extraEnvVars: {
        KORTIX_AGENT_NAME: 'meta',
        KORTIX_META_AGENT: '1',
        KORTIX_WORKSPACE_AUTO_CLONE: '0',
      },
    });
  });
  test('a meta session with an omitted agent spawns the project default, not another meta', async () => {
    enableMetaAgent();
    sessionRow = { ...sessionRow!, agentName: 'meta' };
    const app = createApp();
    const response = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SESSION_BOUND_PAT}`,
      },
      body: JSON.stringify({ provider: 'daytona', base_ref: 'main' }),
    });

    expect(response.status).toBe(201);
    const created = await response.json();
    // The fixture project declares `default_agent: 'kortix'` — a meta-session
    // spawn resolves to it, never to another platform meta coordinator.
    expect(created.agent_name).toBe('kortix');
    expect(created.metadata?.sandbox_slug).not.toBe('meta');
    expect(created.metadata?.spawned_by_session).toBe(SESSION_ID);
  });

  test('a meta session cannot spawn another meta coordinator', async () => {
    enableMetaAgent();
    sessionRow = { ...sessionRow!, agentName: 'meta' };
    const app = createApp();
    const response = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SESSION_BOUND_PAT}`,
      },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        agent_name: 'meta',
      }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('META_AGENT_RECURSION');
  });

  test('a non-meta session-bound caller may still spawn the meta coordinator', async () => {
    enableMetaAgent();
    const app = createApp();
    const response = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SESSION_BOUND_PAT}`,
      },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        agent_name: 'meta',
      }),
    });

    expect(response.status).toBe(201);
    expect((await response.json()).agent_name).toBe('meta');
  });

  test('GET project session inventory rejects callers without project.session.read', async () => {
    deniedIamAction = 'project.session.read';
    const app = createApp();

    const response = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`);

    expect(response.status).toBe(403);
    expect(assertedIamActions).toContain('project.session.read');
  });

  test('in-place resume keeps stopped state and billing closed until the provider proves running', async () => {
    const staleReadyWaitStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    sessionRow = {
      ...sessionRow!,
      status: 'stopped',
      error:
        'The original sandbox is unavailable. Its identity was preserved and no replacement sandbox was created.',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        provider: 'platinum',
        externalId: 'original-provider-identity',
        baseUrl: null,
        status: 'stopped',
        config: {},
        metadata: {
          initStatus: 'ready',
          initSucceededAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          opencodeReadyWaitStartedAt: staleReadyWaitStartedAt,
          opencodeReadyWaitReason: 'unreachable',
          runtimeIdentityState: 'unavailable',
          runtimeUnavailableReason: 'runtime_not_ready_timeout',
        },
        lastUsedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    providerStartGate = new Promise<void>((resolve) => {
      releaseProviderStart = resolve;
    });

    const won = await resumeStoppedSandbox({
      sandboxId: SESSION_ID,
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      provider: 'platinum',
      externalId: 'original-provider-identity',
      metadata: sessionSandboxRows[0]!.metadata as Record<string, unknown>,
    });

    expect(won).toBe(true);
    expect(sessionRow).toMatchObject({ status: 'stopped' });
    expect(sessionSandboxRows[0]).toMatchObject({
      status: 'stopped',
      externalId: 'original-provider-identity',
      metadata: {
        initStatus: 'ready',
        runtimeWakeProviderStatus: 'starting',
      },
    });
    const resumedMetadata = sessionSandboxRows[0]!.metadata as Record<string, unknown>;
    expect(resumedMetadata.opencodeReadyWaitStartedAt).toBeUndefined();
    expect(resumedMetadata.opencodeReadyWaitReason).toBeUndefined();
    expect(resumedMetadata.runtimeIdentityState).toBeUndefined();
    expect(resumedMetadata.runtimeUnavailableReason).toBeUndefined();
    expect(resumedMetadata.runtimeWakeStartedAt).toEqual(expect.any(String));
    expect(resumedMetadata.runtimeWakeId).toEqual(expect.any(String));
    expect(computeReopenCalls).toBe(0);

    providerStatus = 'running';
    releaseProviderStart?.();
    await flushUntil(() => sessionSandboxRows[0]?.status === 'active');
    expect(sessionRow).toMatchObject({ status: 'running', error: null });
    expect(sessionSandboxRows[0]?.status).toBe('active');
    expect(computeReopenCalls).toBe(1);
  });

  test('provider reconciliation observes a stopped row while an in-place resume is starting', async () => {
    sessionRow = {
      ...sessionRow!,
      status: 'stopped',
      error: null,
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        provider: 'platinum',
        externalId: 'platinum-resume-race',
        baseUrl: null,
        status: 'stopped',
        config: {},
        metadata: { initStatus: 'ready' },
        lastUsedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    providerStartGate = new Promise<void>((resolve) => {
      releaseProviderStart = resolve;
    });

    const won = await resumeStoppedSandbox({
      sandboxId: SESSION_ID,
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      provider: 'platinum',
      externalId: 'platinum-resume-race',
      metadata: sessionSandboxRows[0]!.metadata as Record<string, unknown>,
    });
    const reconciled = await reconcileSandboxStoppedByExternalId(
      'platinum-resume-race',
      new Date(),
    );
    expect(won).toBe(true);
    expect(reconciled).toBe(false);
    expect(sessionSandboxRows[0]?.status).toBe('stopped');
    expect(sessionRow?.status).toBe('stopped');
    expect(computeReopenCalls).toBe(0);

    providerStatus = 'running';
    releaseProviderStart?.();
    await flushUntil(() => sessionSandboxRows[0]?.status === 'active');
    expect(computeReopenCalls).toBe(1);
  });

  test('provider start rejection keeps both rows stopped and opens no compute meter', async () => {
    sessionRow = { ...sessionRow!, status: 'stopped', error: null };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        provider: 'platinum',
        externalId: 'platinum-rejected-wake',
        baseUrl: null,
        status: 'stopped',
        config: {},
        metadata: { initStatus: 'ready' },
        lastUsedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    providerStartError = new Error('provider rejected start');

    expect(
      await resumeStoppedSandbox({
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        provider: 'platinum',
        externalId: 'platinum-rejected-wake',
        metadata: sessionSandboxRows[0]!.metadata as Record<string, unknown>,
      }),
    ).toBe(true);
    await flushUntil(
      () =>
        typeof (sessionSandboxRows[0]?.metadata as Record<string, unknown>)?.runtimeWakeFailedAt ===
        'string',
    );

    expect(sessionSandboxRows[0]?.status).toBe('stopped');
    expect(sessionRow?.status).toBe('stopped');
    expect(computeReopenCalls).toBe(0);
    const failureMetadata = sessionSandboxRows[0]?.metadata as Record<string, unknown>;
    expect(failureMetadata.runtimeWakeError).toBe('start_failed');
    expect(typeof failureMetadata.runtimeWakeFailedAt).toBe('string');
    expect(typeof failureMetadata.runtimeWakeRetryAfterAt).toBe('string');
    expect(failureMetadata.runtimeWakeId).toBeUndefined();
    expect(Date.parse(String(failureMetadata.runtimeWakeRetryAfterAt))).toBeGreaterThan(Date.now());

    const response = await createApp().request(
      `/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`,
      { method: 'POST' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      stage: 'stopped',
      retriable: false,
      reason: 'runtime_wake_cooldown',
      sandbox: { status: 'stopped' },
      failure: {
        category: 'sandbox-provider',
        retryable: true,
      },
    });
    expect(providerStartCalls).toBe(1);
  });

  test('concurrent stopped-session resumes issue one provider start and open one meter', async () => {
    sessionRow = { ...sessionRow!, status: 'stopped', error: null };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        provider: 'platinum',
        externalId: 'platinum-single-flight-wake',
        baseUrl: null,
        status: 'stopped',
        config: {},
        metadata: { initStatus: 'ready' },
        lastUsedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    providerStartGate = new Promise<void>((resolve) => {
      releaseProviderStart = resolve;
    });
    const input = {
      sandboxId: SESSION_ID,
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      provider: 'platinum',
      externalId: 'platinum-single-flight-wake',
      metadata: sessionSandboxRows[0]!.metadata as Record<string, unknown>,
    };

    const [first, second] = await Promise.all([
      resumeStoppedSandbox(input),
      resumeStoppedSandbox(input),
    ]);
    await flushUntil(() => providerStartCalls > 0);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(providerStartCalls).toBe(1);
    expect(computeReopenCalls).toBe(0);

    providerStatus = 'running';
    releaseProviderStart?.();
    await flushUntil(() => sessionSandboxRows[0]?.status === 'active');
    expect(computeReopenCalls).toBe(1);
  });

  test('a manual stop wins when provider start resolves after the stop', async () => {
    sessionRow = {
      ...sessionRow!,
      status: 'stopped',
      error: null,
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        provider: 'platinum',
        externalId: 'platinum-cancelled-wake',
        baseUrl: null,
        status: 'stopped',
        config: {},
        metadata: { initStatus: 'ready' },
        lastUsedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    providerStartGate = new Promise<void>((resolve) => {
      releaseProviderStart = resolve;
    });

    expect(
      await resumeStoppedSandbox({
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        provider: 'platinum',
        externalId: 'platinum-cancelled-wake',
        metadata: sessionSandboxRows[0]!.metadata as Record<string, unknown>,
      }),
    ).toBe(true);
    await applyStoppedState({
      sandboxId: SESSION_ID,
      sessionId: SESSION_ID,
      externalId: 'platinum-cancelled-wake',
      // Top-level, not nested in `metadata`: the patch sets `stopReason` from
      // the required field AFTER spreading `metadata`, so a nested one is
      // overwritten and `JSON.stringify` drops the resulting undefined.
      stopReason: 'manual',
      metadata: { stoppedBy: USER_ID },
    });
    releaseProviderStart?.();
    await flushUntil(() => providerStopCalls === 1);

    expect(providerStopCalls).toBe(1);
    expect(sessionSandboxRows[0]?.status).toBe('stopped');
    expect(sessionRow?.status).toBe('stopped');
  });

  test('upserts and lists project secrets without exposing secret values', async () => {
    const app = createApp();

    const writeRes = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
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

    const listRes = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets`);
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

    const deleteRes = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets/openai_api_key`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });
    expect(secretRows).toHaveLength(0);
  });

  test('a session agent can verify writes when runtime delivery is narrowed to zero secrets', async () => {
    sessionRow = { ...sessionRow!, secretsAllowlist: [] };
    const app = createApp();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SESSION_AGENT_PAT}`,
    };

    const writeRes = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'ANTHROPIC_API_KEY', value: 'test-secret' }),
    });
    expect(writeRes.status).toBe(200);
    expect(await writeRes.json()).toMatchObject({
      identifier: 'ANTHROPIC_API_KEY',
      configured: true,
    });

    const listRes = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      headers,
    });
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toMatchObject({
      items: [
        expect.objectContaining({
          identifier: 'ANTHROPIC_API_KEY',
          configured: true,
        }),
      ],
    });
  });

  test('stores provider-neutral git credentials outside runtime project secrets', async () => {
    projectRow.repoUrl = 'https://gitlab.com/acme/private-project.git';
    projectRow.metadata = {
      git: { provider: 'gitlab', auth: { method: 'none' } },
    };
    const app = createApp();

    const before = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets`);
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    expect(
      beforeBody.items.find((item: any) => item.name === 'KORTIX_GIT_AUTH_TOKEN'),
    ).toBeUndefined();

    const writeRes = await app.request(`/v1/projects/${WORKSPACE_ID}/git-credential`, {
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
      `/v1/projects/${WORKSPACE_ID}/secrets/KORTIX_GIT_AUTH_TOKEN`,
      {
        method: 'DELETE',
      },
    );
    expect(deleteRes.status).toBe(403);
    expect(secretRows).toHaveLength(0);

    const createRes = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
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
        workspaceId: WORKSPACE_ID,
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

    const cloneRes = await app.request(`/v1/projects/${WORKSPACE_ID}/git/clone-credential`, {
      headers: { Authorization: `Bearer ${WORKSPACE_SANDBOX_TOKEN}` },
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

  test('derives session origin from the caller token without session attribution fields', async () => {
    const app = createApp();
    const bodySpoof = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        metadata: { source: 'system:forged' },
      }),
    });
    expect(bodySpoof.status).toBe(201);
    expect(((await bodySpoof.json()) as { origin: string }).origin).toBe('user');

    const userRes = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'daytona', base_ref: 'main' }),
    });
    expect(userRes.status).toBe(201);
    const userBody = (await userRes.json()) as Record<string, unknown>;
    expect(userBody.origin).toBe('user');
    expect(userBody).not.toHaveProperty('end_user_ref');
    expect(userBody).not.toHaveProperty('origin_ref');
    expect(lastSessionInsertValues).not.toHaveProperty('originRef');

    const backendRes = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKSPACE_SA_TOKEN}`,
      },
      body: JSON.stringify({ provider: 'daytona', base_ref: 'main' }),
    });
    expect(backendRes.status).toBe(201);
    const backendBody = (await backendRes.json()) as Record<string, unknown>;
    expect(backendBody.origin).toBe('backend');
    expect(backendBody).not.toHaveProperty('end_user_ref');
    expect(backendBody).not.toHaveProperty('origin_ref');
    expect(lastSessionInsertValues).not.toHaveProperty('originRef');

    const patRes = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKSPACE_RUNTIME_PAT}`,
      },
      body: JSON.stringify({ provider: 'daytona', base_ref: 'main' }),
    });
    expect(patRes.status).toBe(201);
    const patBody = (await patRes.json()) as Record<string, unknown>;
    expect(patBody.origin).toBe('backend');
    expect(patBody).not.toHaveProperty('end_user_ref');
    expect(patBody).not.toHaveProperty('origin_ref');
  });

  test('runtime workspaces deny repository metadata and clone credentials to both session tokens', async () => {
    sessionRow!.metadata = { workspace_mode: 'runtime' };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        provider: 'daytona',
        externalId: null,
        baseUrl: null,
        status: 'active',
        config: {},
        metadata: {},
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    const app = createApp();

    for (const [namespace, noun] of [
      ['workspaces', 'workspace'],
      ['projects', 'project'],
    ] as const) {
      const entityRes = await app.request(`/v1/${namespace}/${WORKSPACE_ID}`, {
        headers: { Authorization: `Bearer ${SESSION_AGENT_PAT}` },
      });
      expect(entityRes.status).toBe(403);
      expect(await entityRes.json()).toMatchObject({
        message: `session ${noun} does not allow repository access`,
      });

      const patCloneRes = await app.request(
        `/v1/${namespace}/${WORKSPACE_ID}/git/clone-credential`,
        { headers: { Authorization: `Bearer ${SESSION_AGENT_PAT}` } },
      );
      expect(patCloneRes.status).toBe(403);
      expect(await patCloneRes.json()).toMatchObject({
        message: `session ${noun} does not allow repository access`,
      });

      const sandboxCloneRes = await app.request(
        `/v1/${namespace}/${WORKSPACE_ID}/git/clone-credential`,
        { headers: { Authorization: `Bearer ${WORKSPACE_SANDBOX_TOKEN}` } },
      );
      expect(sandboxCloneRes.status).toBe(403);
      expect(await sandboxCloneRes.json()).toMatchObject({
        error: `sandbox ${noun} does not allow repository access`,
      });

      for (const suffix of ['diff', 'merge-preview']) {
        const crRes = await app.request(
          `/v1/${namespace}/${WORKSPACE_ID}/change-requests/00000000-0000-4000-a000-000000000801/${suffix}`,
          { headers: { Authorization: `Bearer ${SESSION_AGENT_PAT}` } },
        );
        expect(crRes.status).toBe(403);
        expect(await crRes.json()).toMatchObject({
          message: `session ${noun} does not allow repository access`,
        });
      }
    }
  });

  test('rejects removed session attribution fields', async () => {
    const app = createApp();

    for (const body of [
      {
        provider: 'daytona',
        base_ref: 'main',
        end_user_ref: 'legacy-reference',
      },
      { provider: 'daytona', base_ref: 'main', origin_ref: 'legacy-reference' },
    ]) {
      const response = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WORKSPACE_RUNTIME_PAT}`,
        },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
    }
  });

  test('secrets allowlist is backend-only, existence-checked, and persisted', async () => {
    const app = createApp();

    // Seed a runtime secret so the allowlist has a valid identifier to name.
    const seed = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'GMAIL_TOKEN', value: 'g' }),
    });
    expect(seed.status).toBe(200);

    // A non-backend (human/supabase) caller may NOT narrow secrets.
    const forbidden = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        secrets: ['GMAIL_TOKEN'],
      }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      code: 'origin_override_forbidden',
    });

    // A backend (PAT) caller naming an unknown identifier fails fast at create.
    const unknown = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKSPACE_RUNTIME_PAT}`,
      },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        secrets: ['DOES_NOT_EXIST'],
      }),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      code: 'SECRET_IDENTIFIER_NOT_FOUND',
    });

    // A backend caller with a valid identifier → 201, allowlist persisted + echoed.
    const ok = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKSPACE_RUNTIME_PAT}`,
      },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        secrets: ['GMAIL_TOKEN'],
      }),
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).secrets_allowlist).toEqual(['GMAIL_TOKEN']);

    // An empty allowlist (inject ZERO project secrets) is a valid backend request.
    const zero = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKSPACE_RUNTIME_PAT}`,
      },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        secrets: [],
      }),
    });
    expect(zero.status).toBe(201);
    expect((await zero.json()).secrets_allowlist).toEqual([]);
  });

  test('rejects an allowlist whose identifiers collide on one env key (409, not a bricked session)', async () => {
    const mk = (identifier: string, value: string) => ({
      secretId: crypto.randomUUID(),
      workspaceId: WORKSPACE_ID,
      identifier,
      name: 'GOOGLE_MAPS_API_KEY',
      valueEnc: encryptWorkspaceSecret(WORKSPACE_ID, value),
      scope: 'runtime' as const,
      ownerUserId: null,
      description: null,
      strategy: 'runtime' as const,
      consumer: 'sandbox' as const,
      egressPolicy: null,
      handlePrefix: null,
      rotatedAt: null,
      strategyLocked: false,
      active: true,
      createdBy: USER_ID,
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    secretRows = [mk('GMAPS_PRIMARY', 'a'), mk('GMAPS_BACKUP', 'b')];
    const app = createApp();

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKSPACE_RUNTIME_PAT}`,
      },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        secrets: ['GMAPS_PRIMARY', 'GMAPS_BACKUP'],
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'SECRET_IDENTIFIER_KEY_COLLISION',
    });
  });

  test('backend overrides for model, secrets, and agent apply at boot', async () => {
    const app = createApp();

    for (const [name, value] of [
      ['GMAIL_TOKEN', 'g-secret'],
      ['STRIPE_SECRET', 's-secret'],
    ] as const) {
      const w = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          value,
          strategy: 'runtime',
          consumer: 'sandbox',
        }),
      });
      expect(w.status).toBe(200);
    }

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKSPACE_RUNTIME_PAT}`,
      },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        opencode_model: 'anthropic/claude-opus-4-8',
        agent_name: 'default',
        secrets: ['GMAIL_TOKEN'],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      origin: string;
      secrets_allowlist: string[] | null;
    };
    expect(body.origin).toBe('backend');
    expect(body.secrets_allowlist).toEqual(['GMAIL_TOKEN']);

    await flushUntil(() => sandboxProvisionCalls === 1);
    const env = lastProvisionInput!.extraEnvVars ?? {};
    expect(env).not.toHaveProperty('KORTIX_END_USER_REF');
    expect(env).not.toHaveProperty('KORTIX_ORIGIN_REF');
    expect(env.KORTIX_OPENCODE_MODEL).toBe('anthropic/claude-opus-4-8');
    expect(env.GMAIL_TOKEN).toBe('g-secret');
    expect(env.STRIPE_SECRET).toBeUndefined();

    const res2 = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WORKSPACE_RUNTIME_PAT}`,
      },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        agent_name: 'reviewer',
      }),
    });
    expect(res2.status).toBe(201);
    expect((await res2.json()).agent_name).toBe('reviewer');
    await flushUntil(() => sandboxProvisionCalls === 2);
    expect(lastProvisionInput!.extraEnvVars?.KORTIX_AGENT_NAME).toBe('reviewer');
  });

  test('legacy attribution query parameters do not filter session inventory', async () => {
    const app = createApp();
    const renderWhere = () => new PgDialect().sqlToQuery(lastSessionListWhere as SQL);

    lastSessionListWhere = null;
    const first = await app.request(
      `/v1/projects/${WORKSPACE_ID}/sessions?end_user_ref=legacy-reference`,
    );
    expect(first.status).toBe(200);
    expect(renderWhere().sql).not.toContain('origin_ref');
    expect(renderWhere().params).not.toContain('legacy-reference');

    lastSessionListWhere = null;
    const second = await app.request(
      `/v1/projects/${WORKSPACE_ID}/sessions?origin_ref=legacy-reference`,
    );
    expect(second.status).toBe(200);
    expect(renderWhere().sql).not.toContain('origin_ref');
    expect(renderWhere().params).not.toContain('legacy-reference');
  });

  test('resolves legacy git auth secret server-side without injecting it into sandbox env', async () => {
    projectRow.repoUrl = 'https://git.example.test/legacy-private-project';
    projectRow.metadata = {};
    secretRows = [
      {
        secretId: '00000000-0000-4000-a000-000000000402',
        workspaceId: WORKSPACE_ID,
        identifier: 'KORTIX_GIT_AUTH_TOKEN',
        name: 'KORTIX_GIT_AUTH_TOKEN',
        valueEnc: encryptWorkspaceSecret(WORKSPACE_ID, 'legacy-git-token'),
        scope: 'runtime',
        ownerUserId: null,
        description: null,
        strategy: 'broker' as const,
        consumer: 'git_proxy' as const,
        egressPolicy: null,
        handlePrefix: null,
        rotatedAt: null,
        strategyLocked: false,
        active: true,
        createdBy: USER_ID,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    const app = createApp();

    const createRes = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
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
        workspaceId: WORKSPACE_ID,
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

    const cloneRes = await app.request(`/v1/projects/${WORKSPACE_ID}/git/clone-credential`, {
      headers: { Authorization: `Bearer ${WORKSPACE_SANDBOX_TOKEN}` },
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
    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
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
        body: { metadata: { deletedAt: '2026-07-13T00:00:00Z' } },
        message: 'metadata key is server-managed: deletedAt',
      },
      {
        body: { metadata: { deletedBy: 'user-x' } },
        message: 'metadata key is server-managed: deletedBy',
      },
      {
        // metadata.name is owned by the title generator; planting a non
        // placeholder value pre-empts titling forever. Renaming is `name` →
        // metadata.custom_name.
        body: { metadata: { name: 'zzz' } },
        message: 'metadata key is server-managed: name',
      },
      {
        body: { metadata: { title_source: 'zzz' } },
        message: 'metadata key is server-managed: title_source',
      },
      {
        body: { random: 'field' },
        message: 'field is not user-editable: random',
      },
    ];

    for (const { body, message } of forbiddenBodies) {
      const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}`, {
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

    const listSessions = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`);
    expect(listSessions.status).toBe(200);
    const sessions = await listSessions.json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      session_id: SESSION_ID,
      project_id: WORKSPACE_ID,
      branch_name: SESSION_ID,
      sandbox_id: SESSION_ID,
      status: 'provisioning',
    });

    const inventory = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions?scope=project`);
    expect(inventory.status).toBe(200);
    expect((await inventory.json())[0]).toMatchObject({
      session_id: SESSION_ID,
      owner_email: 'contract@example.test',
      owner_name: 'contract@example.test',
      owner_type: 'user',
      can_access: true,
      runtime_status: null,
      deleted_at: null,
      deleted_by: null,
    });

    const readSession = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}`);
    expect(readSession.status).toBe(200);
    expect(await readSession.json()).toMatchObject({
      session_id: SESSION_ID,
      project_id: WORKSPACE_ID,
      branch_name: SESSION_ID,
      sandbox_id: SESSION_ID,
      status: 'provisioning',
    });

    const invalidSession = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/not-a-uuid`);
    expect(invalidSession.status).toBe(400);
    expect(await invalidSession.json()).toMatchObject({
      error: 'Invalid session id',
    });

    const invalidSandbox = await app.request(
      `/v1/projects/${WORKSPACE_ID}/sessions/not-a-uuid/start`,
      { method: 'POST' },
    );
    expect(invalidSandbox.status).toBe(400);
    expect(await invalidSandbox.json()).toMatchObject({
      error: 'Invalid session id',
    });

    // /start is idempotent: a session with no usable sandbox yet returns a
    // readiness payload (stage='provisioning'), not a 404 — the client polls it.
    const pendingSandbox = await app.request(
      `/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`,
      { method: 'POST' },
    );
    expect(pendingSandbox.status).toBe(200);
    expect(await pendingSandbox.json()).toMatchObject({
      stage: 'provisioning',
      agent_name: 'default',
      runtime_transport: 'rest',
    });

    sessionRow = null;
    const missingSession = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}`);
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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

  test('dashboard start returns one typed terminal capacity failure without re-provisioning', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'failed',
      sandboxProvider: 'e2b',
      error: 'The sandbox provider is at capacity right now. Stop another session and retry.',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        provider: 'e2b',
        externalId: null,
        baseUrl: null,
        status: 'error',
        config: {},
        metadata: {
          initStatus: 'failed',
          initAttempts: 1,
          initMaxAttempts: 1,
          failureCategory: 'provider-capacity',
          errorMessage:
            'The sandbox provider is at capacity right now. Stop another session and retry.',
        },
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.request(
        `/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`,
        { method: 'POST' },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        stage: 'failed',
        retriable: false,
        sandbox: {
          status: 'error',
          metadata: { initAttempts: 1, initMaxAttempts: 1 },
        },
        failure: {
          category: 'provider-capacity',
          message: 'The sandbox provider is at capacity right now. Stop another session and retry.',
          retryable: true,
        },
      });
    }
    expect(sandboxProvisionCalls).toBe(0);
  });

  test('dashboard start upgrades a stored E2B placement failure to the capacity contract', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'failed',
      sandboxProvider: 'e2b',
      error: 'The sandbox provider could not start this session. Try again.',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        provider: 'e2b',
        externalId: null,
        baseUrl: null,
        status: 'error',
        config: {},
        metadata: {
          initStatus: 'failed',
          initAttempts: 3,
          initMaxAttempts: 3,
          failureCategory: 'sandbox-provider',
          errorMessage: 'The sandbox provider could not start this session. Try again.',
          lastProvisioningError: '500: Failed to place sandbox',
        },
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const response = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      stage: 'failed',
      retriable: false,
      failure: {
        category: 'provider-capacity',
        message: 'The sandbox provider is at capacity right now. Try again in a minute.',
        retryable: true,
      },
    });
    expect(sandboxProvisionCalls).toBe(0);
  });

  test('dashboard start exposes an actionable non-retryable protected-delivery failure', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'failed',
      sandboxProvider: 'daytona',
      error:
        'This sandbox provider cannot enforce network-boundary secret delivery. Select Platinum or change the secret delivery policy.',
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        provider: 'daytona',
        externalId: null,
        baseUrl: null,
        status: 'error',
        config: {},
        metadata: {
          initStatus: 'failed',
          initAttempts: 1,
          initMaxAttempts: 1,
          failureCategory: 'unsupported-secret-delivery',
          errorMessage:
            'This sandbox provider cannot enforce network-boundary secret delivery. Select Platinum or change the secret delivery policy.',
          lastProvisioningError:
            'Sandbox provider daytona does not support network-boundary secret delivery',
        },
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const response = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      stage: 'failed',
      retriable: false,
      failure: {
        category: 'unsupported-secret-delivery',
        message:
          'This sandbox provider cannot enforce network-boundary secret delivery. Select Platinum or change the secret delivery policy.',
        retryable: false,
      },
    });
    expect(sandboxProvisionCalls).toBe(0);
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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

  test('dashboard start trusts live runtime health when the provider status stays unknown', async () => {
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
        workspaceId: WORKSPACE_ID,
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
    runtimeInspectionHealth = {
      runtimeReady: true,
      bootError: null,
    };

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'ready',
      retriable: false,
      reason: 'unchanged',
      sandbox: { external_id: 'box-status-unknown', status: 'active' },
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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

  test('a removed stopped runtime keeps the original identity fenced without optimistic activation', async () => {
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stage: 'starting',
      retriable: true,
      reason: 'runtime_waking',
    });
    expect(providerStartCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
    expect(sessionSandboxRows).toHaveLength(1);
    expect(sessionSandboxRows[0]?.externalId).toBe('box-original-archived');
    expect(sessionSandboxRows[0]?.status).toBe('stopped');
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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
    const ready = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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
        workspaceId: WORKSPACE_ID,
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

    const first = app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
      method: 'POST',
    });
    await flushUntil(() => providerRecoveryCalls === 1);
    const second = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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
        workspaceId: WORKSPACE_ID,
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

    const request = app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/restart`, {
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

  test('restart of a meta session keeps the meta runtime env', async () => {
    const app = createApp();
    sessionRow = {
      ...sessionRow!,
      status: 'stopped',
      agentName: 'meta',
      metadata: {
        ...((sessionRow!.metadata as Record<string, unknown>) ?? {}),
        sandbox_slug: 'meta',
      },
    };
    sessionSandboxRows = [];

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/restart`, {
      method: 'POST',
    });

    expect([200, 202]).toContain(res.status);
    await flushUntil(() => sandboxProvisionCalls === 1);
    // The rebuilt env must keep the meta runtime — losing it makes the daemon
    // clone the project over the meta workspace and wipe /workspace/AGENTS.md.
    expect(lastProvisionInput).toMatchObject({
      agentName: 'meta',
      extraEnvVars: {
        KORTIX_META_AGENT: '1',
        KORTIX_WORKSPACE_AUTO_CLONE: '0',
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/restart`, {
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/restart`, {
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

  test('restart trusts live runtime health when the provider status stays unknown', async () => {
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
        workspaceId: WORKSPACE_ID,
        provider: 'platinum',
        externalId: 'box-restarted-status-unknown',
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
    runtimeInspectionHealth = {
      runtimeReady: true,
      bootError: null,
    };

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/restart`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    await flushUntil(() => sessionRow?.status === 'running');
    expect(providerStartCalls).toBe(1);
    expect(sessionRow?.status).toBe('running');
    expect(sessionSandboxRows[0]).toMatchObject({
      externalId: 'box-restarted-status-unknown',
      status: 'active',
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
        workspaceId: WORKSPACE_ID,
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/restart`, {
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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

  test('session create persists a pending prompt without injecting it into the sandbox', async () => {
    const app = createApp();
    const pendingPrompt = {
      text: 'Map this parcel.',
      agent: 'default',
      model: { providerID: 'kortix', modelID: 'claude-sonnet-4-5' },
      variant: 'high',
      attachment_names: ['parcel.geojson'],
    };

    const response = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'daytona',
        pending_prompt: pendingPrompt,
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      metadata: { pending_prompt: pendingPrompt },
    });
    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(lastProvisionInput!.extraEnvVars?.KORTIX_INITIAL_PROMPT).toBeUndefined();
  });

  test('allows only user-owned PATCH fields', async () => {
    const app = createApp();
    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}`, {
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
    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'justavps' }),
    });

    expect(res.status).toBe(400);
    expect(branchCreateCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
  });

  test('e2e: only explicit sandbox secrets are injected as plaintext env vars', async () => {
    const app = createApp();

    for (const input of [
      { name: 'OPENAI_API_KEY', value: 'sk-test-openai' },
      {
        name: 'LOCAL_BUILD_SECRET',
        value: 'local-build-value',
        strategy: 'runtime',
        consumer: 'sandbox',
      },
    ] as const) {
      const writeRes = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      expect(writeRes.status).toBe(200);
    }
    expect(secretRows).toHaveLength(2);
    for (const row of secretRows) {
      expect(row.valueEnc).not.toContain('sk-test-openai');
      expect(row.valueEnc).not.toContain('local-build-value');
    }

    const createRes = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'daytona',
        base_ref: 'main',
        agent_name: 'default',
      }),
    });
    expect(createRes.status).toBe(201);

    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionInput).not.toBeNull();

    const env = lastProvisionInput!.extraEnvVars ?? {};
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.LOCAL_BUILD_SECRET).toBe('local-build-value');

    expect(env.KORTIX_WORKSPACE_ID).toBe(WORKSPACE_ID);
    expect(env.KORTIX_SESSION_ID).toBeTruthy();
    const expectedRepoUrl =
      process.env.KORTIX_GIT_PROXY === 'true'
        ? new URL(
            `/v1/git/${WORKSPACE_ID}.git`,
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

    const shadowRes = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'KORTIX_TOKEN', value: 'phishy' }),
    });
    expect(shadowRes.status).toBe(400);
  });

  test('inherits the project environment branch and preserves the session/sandbox invariant', async () => {
    projectRow.defaultBranch = 'dev';
    const app = createApp();
    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'daytona',
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
    expect(body.base_ref).toBe('dev');
    expect(body.status).toBe('provisioning');
    expect(body.opencode_session_id).toBeNull();
    expect(body.name).toBe('Contract session');
    await flushUntil(() => branchCreateCalls === 1);
    expect(branchCreateCalls).toBe(1);
    expect(sessionRow?.baseRef).toBe('dev');
    expect(sessionRow?.opencodeSessionId).toBeNull();

    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionInput!.extraEnvVars?.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBe('1');
    expect(lastProvisionInput!.extraEnvVars?.KORTIX_BASE_REF).toBe('dev');
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
    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
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
      const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime_context: runtimeContext }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe('INVALID_SESSION_RUNTIME_CONTEXT');
      expect(sessionRow).toBeNull();
      expect(runtimeContextRows).toHaveLength(0);
      expect(sandboxProvisionCalls).toBe(0);
    }
  });

  test('rejects unknown session-create fields at the HTTP boundary', async () => {
    const app = createApp();
    sessionRow = null;

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/start`, {
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

    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/restart`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(JSON.parse(lastProvisionInput!.extraEnvVars!.KORTIX_SESSION_CONTEXT!)).toEqual(context);
  });

  test('explicit restart replaces an unmaterialized capacity failure without auto-sending its prompt', async () => {
    const app = createApp();
    const pendingPrompt = {
      text: 'Map this parcel safely.',
      agent: 'default',
      model: null,
      variant: null,
      attachment_names: ['parcel.geojson'],
    };
    sessionRow = {
      ...sessionRow!,
      sandboxProvider: 'daytona',
      status: 'failed',
      error: 'The sandbox provider is at capacity right now. Try again in a minute.',
      metadata: { pending_prompt: pendingPrompt },
    };
    sessionSandboxRows = [
      {
        sandboxId: SESSION_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        provider: 'daytona',
        externalId: null,
        baseUrl: null,
        status: 'error',
        config: {},
        metadata: {
          initStatus: 'failed',
          initAttempts: 1,
          initMaxAttempts: 1,
          failureCategory: 'provider-capacity',
        },
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const response = await app.request(
      `/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}/restart`,
      { method: 'POST' },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      ok: true,
      session_id: SESSION_ID,
      status: 'provisioning',
    });
    await flushUntil(() => sandboxProvisionCalls === 1);
    expect(lastProvisionInput!.extraEnvVars?.KORTIX_INITIAL_PROMPT).toBeUndefined();
  });

  test('accepts a client-created session branch without recreating it server-side', async () => {
    const app = createApp();
    const clientSessionId = '11111111-1111-4111-a111-111111111111';
    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
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
    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sessionRow?.status).toBe('stopped');
    expect(sessionRow?.branchName).toBe(SESSION_ID);

    sessionRow = null;
    const missing = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions/${SESSION_ID}`, {
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'Not found' });
  });

  test('rejects concurrent session cap before creating a git branch', async () => {
    activeSessionCount = 1;
    const app = createApp();
    const res = await app.request(`/v1/projects/${WORKSPACE_ID}/sessions`, {
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
