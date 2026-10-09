/**
 * Trigger fire paths that HTTP on a local stack cannot reach: the cron sweep
 * and execution drain (the local profile runs no scheduler), a fire that
 * provisions a sandbox, the lifecycle queue drain, and the manifest-refresh
 * budget a bad webhook signature spends. Each case guards a fixed bug:
 * project model default (2660e21995), backpressured cron slots (c4905dc496),
 * reuse delivery recorded as fired (#7124), refresh budget (e36198b879),
 * queued webhook create drained into one session (aa9c12934c).
 *
 * The CRUD, webhook authentication and backpressure-queueing contracts run
 * over real HTTP in TRG-2..4 and TRG-17..19 (tests/src/flows/triggers.flow.ts).
 * Automation alerts (KRTX-1742): only a dead-lettered slot raises one, a
 * retried attempt never does; their SQL edge runs in
 * integration-trigger-alerts.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamEngineAllowAll, mockIamReadModels } from './helpers/iam-mocks';
import { createHmac, randomUUID } from 'node:crypto';
import { SQL, is } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountGithubInstallations,
  accountMembers,
  projectMembers,
  projectSecrets,
  projectSessions,
  projectTriggerRuntime,
  projects,
  sessionLifecycleCommands,
} from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const SERVICE_ACCOUNT_ID = '00000000-0000-4000-a000-000000000002';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const MANIFEST_PATH = 'kortix.yaml';
const TEST_AUTH_KEY = '__KORTIX_E2E_AUTH__';

process.env.DAYTONA_API_KEY = 'test-daytona-key';
process.env.DAYTONA_SERVER_URL = 'https://daytona.example.test';
process.env.DAYTONA_TARGET = 'test-target';
process.env.KORTIX_URL = 'https://api.example.test';
process.env.LLM_GATEWAY_ENABLED = 'true';

// ─── In-memory git mock ─────────────────────────────────────────────────────
// Every git read/write goes through this map so a test's "commitFile" is
// observable by the very next "listRepoFiles" / "readRepoFile" call. That
// mirrors the post-write `invalidateProjectMirror` behavior in production.

let repoFiles: Map<string, string>;
let commitCalls: Array<{ path: string; message: string }>;
let deleteCalls: Array<{ path: string; message: string }>;
let branchCreateCalls = 0;
let sandboxProvisionCalls = 0;
let lastProvisionEnv: Record<string, string> | null = null;
let runtimeRows: any[];
let triggerExecutionRows: any[];
let sessionRows: Array<typeof projectSessions.$inferSelect>;
let lifecycleCommandRows: Array<typeof sessionLifecycleCommands.$inferSelect>;
let activeSessionCount = 0;
let walletBalance = 1_000_000;
let automationActor: string | null = USER_ID;
const alertCalls: Array<{ kind: 'raise' | 'clear'; input: Record<string, unknown> }> = [];
const watcherCalls: Array<{ kind: 'follow' | 'drop'; ref: Record<string, unknown> }> = [];
/** The credential kind the mocked auth reports; unset by default, as before. */
let testAuthType: string | undefined;
/** Set to make that seam throw: the provider pick, the model defaults read, a watcher write. */
let providerFailure: Error | null = null;
let modelDefaultsFailure: Error | null = null;
let watcherFailure: Error | null = null;
let provisioningSessionCount = 0;
let secretRows: Array<typeof projectSecrets.$inferSelect>;
let manifestReadCalls = 0;
let mirrorInvalidationCalls = 0;
let manifestCommitConflictsRemaining = 0;
let modelDefaults: {
  account: string | null;
  agents: Record<string, string>;
  projects: Record<string, string>;
};

function setTestAuth(userId = USER_ID, userEmail = 'triggers@example.test') {
  (globalThis as any)[TEST_AUTH_KEY] = { userId, userEmail };
}

function getTestAuth() {
  return (globalThis as any)[TEST_AUTH_KEY] ?? { userId: USER_ID, userEmail: 'triggers@example.test' };
}

const projectRow: typeof projects.$inferSelect = {
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  name: 'Trigger Project',
  sandboxProviderGeneration: 0,
  secretDefaultStrategy: 'runtime' as const,
  repoUrl: 'https://github.com/kortix-ai/trigger-project.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  idempotencyKey: null,
  status: 'active',
  metadata: {},
  lastOpenedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function resetState() {
  resetRateLimiters();
  setTestAuth();
  repoFiles = new Map();
  commitCalls = [];
  deleteCalls = [];
  branchCreateCalls = 0;
  sandboxProvisionCalls = 0;
  lastProvisionEnv = null;
  runtimeRows = [];
  triggerExecutionRows = [];
  sessionRows = [];
  lifecycleCommandRows = [];
  activeSessionCount = 0;
  provisioningSessionCount = 0;
  secretRows = [];
  manifestReadCalls = 0;
  mirrorInvalidationCalls = 0;
  manifestCommitConflictsRemaining = 0;
  modelDefaults = { account: null, agents: {}, projects: {} };
  projectRow.metadata = {};
  secretValues.clear();
  secretConsumerConfigurationStates.clear();
  secretConsumerReads.length = 0;
  walletBalance = 1_000_000;
  automationActor = USER_ID;
  alertCalls.length = 0;
  watcherCalls.length = 0;
  testAuthType = undefined;
  providerFailure = null;
  modelDefaultsFailure = null;
  watcherFailure = null;
}

function sign(rawBody: string, secret: string) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

mockIamEngineAllowAll();

// The hermetic db shim models the legacy tables; the read models project from
// those rows rather than from `role_assignments`. See mockIamReadModels.
mockIamReadModels();

mock.module('../projects/session-lifecycle/actor', () => ({
  resolveProjectAutomationActor: async () => automationActor,
  resolveAgentRunAttribution: async () => SERVICE_ACCOUNT_ID,
}));

const realAuthMiddleware = await import('../middleware/auth');
mock.module('../middleware/auth', () => ({
  ...realAuthMiddleware,
  supabaseAuth: async (c: any, next: any) => {
    const auth = getTestAuth();
    c.set('userId', auth.userId);
    c.set('userEmail', auth.userEmail);
    if (testAuthType) c.set('authType', testAuthType);
    await next();
  },
}));

const actualGit = await import('../projects/git');
mock.module('../projects/git', () => ({
  ...actualGit,
  grepRepoFiles: async () => [],
  searchRepoFileNames: async () => [],
  createRemoteSessionBranch: async () => {
    branchCreateCalls += 1;
  },
  archiveRepoSubtree: async () => undefined,
  listRepoFiles: async (_project: any, _ref: string, path?: string) => {
    const prefix = (path ?? '').replace(/\/$/, '');
    const entries = Array.from(repoFiles.keys())
      .filter((p) => !prefix || p.startsWith(prefix + '/') || p === prefix)
      .map((p) => ({ path: p, type: 'file' as const, size: null }));
    return entries;
  },
  readRepoFile: async (_project: any, path: string) => {
    const content = repoFiles.get(path);
    if (content === undefined) throw new Error(`Not found: ${path}`);
    return content;
  },
  readManifestFromRepo: async (_p: any, candidatePaths: string[]) => {
    manifestReadCalls += 1;
    for (const path of candidatePaths) {
      const content = repoFiles.get(path);
      if (content !== undefined) {
        return {
          path,
          content,
          sha: `sha-${path}`,
          candidatePaths,
        };
      }
    }
    return null;
  },
  loadProjectConfig: async () => ({ env: { required: [], optional: [] } }),
  listBranches: async () => [],
  remoteBranchExists: async () => true,
  listCommits: async () => ({ entries: [], nextCursor: null }),
  getCommit: async () => null,
  getCommitDiff: async () => null,
  getFileHistory: async () => ({ entries: [], nextCursor: null }),
  invalidateProjectMirror: () => {
    mirrorInvalidationCalls += 1;
  },
  resolveCommitSha: async () => 'a'.repeat(40),
  resolveFastBootGitHint: async () => ({ baseSha: 'a'.repeat(40) }),
  resolveBranchTip: async () => 'a'.repeat(40),
  getBranchDiff: async () => ({ files: [], diff: '' }),
  getDiffBetweenShas: async () => ({ files: [], diff: '' }),
  previewMerge: async () => ({ canMerge: true, conflicts: [] }),
  mergeBranches: async () => ({ mergedSha: 'a'.repeat(40) }),
  commitFileToBranch: async (_project: unknown, opts: { path: string; content: string; message: string }) => {
    if (manifestCommitConflictsRemaining > 0) {
      manifestCommitConflictsRemaining -= 1;
      const error = new Error(`File "${opts.path}" changed since it was read`);
      error.name = 'GitFileRevisionConflictError';
      throw error;
    }
    repoFiles.set(opts.path, opts.content);
    commitCalls.push({ path: opts.path, message: opts.message });
    return { commitSha: 'a'.repeat(40) };
  },
  deleteRemoteSessionBranch: async () => undefined,
  diffStat: async () => ({ files: [], additions: 0, deletions: 0 }),
  getFileAtRef: async () => null,
  getMergeBase: async () => 'a'.repeat(40),
  resolveBranchAheadState: async () => ({ ahead: false, commitsAhead: 0 }),
  resolveTreeOid: async () => 'b'.repeat(40),
  materializeRepoContext: async () => '/tmp/fake-snapshot-context',
}));

mock.module("../snapshots/builder", () => ({
  ensureSandboxImage: async () => ({ snapshotName: "kortix-default-test", slug: "default", contentHash: "a".repeat(64), built: false, isDefault: true }),
  ensureMetaSandboxImage: async () => ({ snapshotName: "kortix-meta-test", slug: "meta", contentHash: "b".repeat(64), built: false, isDefault: false }),
  deleteSandboxImage: async () => ({ deleted: false, snapshotName: "kortix-default-test", slug: "default" }),
  listSnapshotBuilds: async () => [],
  listSandboxTemplates: async () => [],
  resolveTemplate: async () => ({ slug: "default", spec: {}, isDefault: true }),
  kickPreBuild: () => {},
  kickRoutedPreBuild: () => {},
  templateBuildProviders: () => ['daytona', 'platinum', 'e2b'],
  kickProjectTemplatePrebuilds: () => {},
  kickStartupPreBuild: () => {},
  reconcileProjectTemplates: async () => undefined,
  reconcileStaleBuilds: async () => undefined,
  ensurePlatformDefaultImage: async () => undefined,
  resolveCommitSha: async () => "a".repeat(40),
  DEFAULT_SANDBOX_SLUG: "default",
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a factory
// that only lists the exports it overrides deletes every other one — and the
// next export added to `projects/github.ts` becomes
// `SyntaxError: Export named 'X' not found` in this file, which that change
// never touched (.claude/skills/learnings/SKILL.md).
const actualGithub = await import('../projects/github');
mock.module('../projects/github', () => ({
  ...actualGithub,
  parseGitHubRepoUrl: (repoUrl: string) => ({
    owner: 'kortix-org',
    repo: repoUrl.split('/').pop()?.replace(/\.git$/, '') ?? 'trigger-project',
  }),
  buildGitHubAppInstallUrl: () => 'https://github.com/apps/kortix-test/installations/new',
  verifyGitHubAppInstallState: (state: string) => state,
  verifyGitHubAppInstallStatePayload: (state: string) => ({
    accountId: state,
    nonce: 'test-nonce',
    issuedAt: Math.floor(Date.now() / 1000),
  }),
  createGitHubAppJwt: () => 'jwt-test',
  getGitHubPatAuthContext: () => ({ token: 'pat-token', source: 'pat', owner: 'kortix-org' }),
  commitFile: async (opts: { path: string; content: string; message: string }) => {
    repoFiles.set(opts.path, opts.content);
    commitCalls.push({ path: opts.path, message: opts.message });
  },
  createInstallationToken: async () => ({ token: 'installation-token' }),
  createRepo: async () => {
    throw new Error('not used');
  },
  deleteFile: async (opts: { path: string; message: string }) => {
    repoFiles.delete(opts.path);
    deleteCalls.push({ path: opts.path, message: opts.message });
  },
  getFileSha: async (opts: { path: string }) => {
    return repoFiles.has(opts.path) ? `sha-${opts.path}` : null;
  },
  getGitHubAppInstallation: async () => ({
    account: { login: 'kortix-org', type: 'Organization' },
    repository_selection: 'all',
    permissions: {},
  }),
  getRepo: async () => ({
    id: 1,
    name: 'contract-project',
    full_name: 'kortix-org/contract-project',
    private: true,
    html_url: 'https://github.com/kortix-org/contract-project',
    clone_url: 'https://github.com/kortix-org/contract-project.git',
    ssh_url: 'git@github.com:kortix-org/contract-project.git',
    default_branch: 'main',
    description: null,
  }),
  getRepositoryBranch: async ({ branch }: { branch: string }) => ({ name: branch, protected: false }),
  verifyGitHubInstallationAdmin: async () => undefined,
  listLinkableGitHubAppInstallations: async () => [],
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

const realProjectGit = await import('../projects/lib/git');
mock.module('../projects/lib/git', () => ({
  ...realProjectGit,
  resolveProjectGitAuth: async () => ({
    auth: { token: 'test-git-token', source: 'project_credential' },
    authSource: 'project_credential',
  }),
  withProjectGitAuth: async (project: Record<string, unknown>) => ({
    ...project,
    gitAuthToken: 'test-git-token',
    gitAuthHeaders: {},
  }),
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async (input: any) => {
    lastProvisionEnv = await input.extraEnvVars;
    sandboxProvisionCalls += 1;
  },
}));

mock.module('../platform/services/provider-balancer', () => ({
  selectProvider: async () => {
    if (providerFailure) throw providerFailure;
    return 'daytona';
  },
}));

const mockedProjectLlmGatewayEnabled = (metadata: unknown) =>
  (metadata as { experimental?: { llm_gateway?: unknown } } | null)?.experimental
    ?.llm_gateway === true;
mock.module('../llm-gateway/enablement', () => ({
  projectLlmGatewayEnabled: mockedProjectLlmGatewayEnabled,
  // The by-id variant (secrets delivery, title generation) resolves against
  // the same fixture row this suite mutates per test.
  projectLlmGatewayEnabledById: async () => mockedProjectLlmGatewayEnabled(projectRow.metadata),
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: 'triggers@example.test' } } }),
      },
    },
  }),
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  upsertCreditAccount: async () => undefined,
  getSubscriptionInfo: async () => ({ tier: 'pro' }),
  // Trigger fire spawns a real session, which runs the billing gate. Return a
  // billing-active account (live sub + ample balance) so the gate passes.
  getCreditAccount: async () => ({
    accountId: ACCOUNT_ID,
    balance: walletBalance,
    billingModel: 'credits',
    stripeSubscriptionId: 'sub_test',
    stripeSubscriptionStatus: 'active',
  }),
  getCreditBalance: async () => ({ balance: 1_000_000, granted: 1_000_000, used: 0 }),
  updateCreditAccount: async () => {},
}));

// Stub secrets so webhook tests can resolve the trigger's signing secret.
// Tests can read/override `secretValues` to drive specific behaviors.
const secretValues = new Map<string, string>();
const secretConsumerConfigurationStates = new Map<
  string,
  'configured' | 'missing' | 'inactive' | 'delivery_mismatch'
>();
const secretConsumerReads: Array<Record<string, unknown>> = [];
const realProjectSecrets = await import('../projects/secrets');
mock.module('../projects/secrets', () => ({
  ...realProjectSecrets,
  encryptProjectSecret: (_p: string, v: string) => `enc:${v}`,
  decryptProjectSecret: (_p: string, v: string) => v.replace(/^enc:/, ''),
  isValidSecretName: (n: string) => /^[A-Z_][A-Z0-9_]*$/.test(n),
  listProjectSecrets: async () => ({}),
  listProjectSecretsForUser: async () => ({}),
  listProjectSecretsSnapshot: async () => ({ env: {}, names: [], revision: 'empty' }),
  listProjectSecretNamesForConsumer: async () => [],
  listProjectSecretsSnapshotForUser: async () => ({ env: {}, names: [], revision: 'empty' }),
  projectSecretsRevision: async () => 'empty',
  getProjectSecretConsumerConfigurationStatus: async (input: { name: string }) =>
    secretConsumerConfigurationStates.get(input.name) ??
    (secretValues.has(input.name) ? 'configured' : 'missing'),
  getProjectSecretValueForConsumer: async (input: { name: string; consumer: string }) => {
    secretConsumerReads.push(input);
    const configuration =
      secretConsumerConfigurationStates.get(input.name) ??
      (secretValues.has(input.name) ? 'configured' : 'missing');
    return input.consumer === 'connector' && configuration === 'configured'
      ? (secretValues.get(input.name) ?? null)
      : null;
  },
}));

const triggerDbMock: any = {
    execute: async () => [],
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const result: any[] & { orderBy?: () => any; limit?: () => Promise<any[]> } = [];
          (result as any).for = () => result;
          result.orderBy = () => {
            const rows =
              table === sessionLifecycleCommands
                ? lifecycleCommandRows
                : table === projectSessions
                  ? sessionRows
                  : table === projects
                    ? [projectRow]
                    : [];
            const ordered = {
              // `selectActiveProjects` chains `.orderBy(...).limit(n).offset(m)` —
              // `limit()` must return a chainable (and still awaitable) object so
              // both `await ...limit(n)` and `...limit(n).offset(m)` resolve.
              limit: (limit: number) => {
                const limited = rows.slice(0, limit);
                const chain = {
                  offset: async (offset: number) => limited.slice(offset),
                  // The lifecycle claim locks its picks: `.limit(n).for('update', …)`.
                  for: () => chain,
                  then: (resolve: (rows: any[]) => unknown) => resolve(limited),
                };
                return chain;
              },
              then: (resolve: (rows: any[]) => unknown) => resolve(rows),
            };
            return ordered as any;
          };
          result.limit = async () => {
            if (fields && Object.keys(fields).includes('activeCount')) {
              return [{ activeCount: activeSessionCount }];
            }
            if (fields && Object.keys(fields).includes('provisioningCount')) {
              return [{ provisioningCount: provisioningSessionCount }];
            }
            if (table === projects) return [projectRow];
            if (table === accountMembers) {
              return [{ accountId: ACCOUNT_ID, accountRole: 'owner', userId: USER_ID }];
            }
            if (table === accountGithubInstallations) return [];
            if (table === projectMembers) return [];
            if (table === projectSessions) return sessionRows.slice(0, 1);
            if (table === sessionLifecycleCommands) return lifecycleCommandRows.slice(0, 1);
            // `getGitTriggerRuntime` does a bare `.select().from(projectTriggerRuntime)
            // .where(...).limit(1)` (no `orderBy`, no field projection) — without this
            // branch it always fell through to `[]`, so the sweep never saw a prior
            // fire's `lastFiredAt` and recomputed the same due-slot idempotency key on
            // every retry (masking backpressure clearing). Mirrors the `.then()`
            // fallback below.
            if (table === projectTriggerRuntime) {
              return runtimeRows.filter((r) => r.projectId === PROJECT_ID).slice(0, 1);
            }
            return [];
          };
          // Some callers `await` directly without orderBy/limit (e.g. select
          // from runtime table). Make `result` a thenable that resolves to
          // the runtime rows for that table when iterated.
          (result as any).then = (resolve: (rows: any[]) => unknown) => {
            if (table === projectTriggerRuntime) {
              resolve(runtimeRows.filter((r) => r.projectId === PROJECT_ID));
            } else if (table === projectSecrets) resolve(secretRows);
            else if (table === sessionLifecycleCommands) resolve(lifecycleCommandRows);
            else resolve([]);
          };
          return result;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        returning: async () => {
          const now = new Date('2026-01-02T00:00:00Z');
          if (table === projectSessions) {
            const row: typeof projectSessions.$inferSelect = {
              sessionId: values.sessionId,
              accountId: values.accountId,
              projectId: values.projectId,
              branchName: values.branchName,
              baseRef: values.baseRef,
              sandboxProvider: values.sandboxProvider,
              sandboxId: values.sandboxId ?? null,
              sandboxUrl: null,
              runtimeSessionId: null,
              agentName: values.agentName ?? 'default',
              status: values.status ?? 'provisioning',
              error: null,
              createdBy: values.createdBy ?? null,
              visibility: values.visibility ?? 'private',
              origin: values.origin ?? 'user',
              originRef: values.originRef ?? null,
              parentSessionId: values.parentSessionId ?? null,
              initiatorType: values.initiatorType ?? null,
              initiatorId: values.initiatorId ?? null,
              secretsAllowlist: values.secretsAllowlist ?? null,
              requiredConnectors: null,
              connectorBindingsInheritUnbound: values.connectorBindingsInheritUnbound ?? false,
              connectorBindingsConfigured: values.connectorBindingsConfigured ?? false,
              labels: values.labels ?? [],
              metadata: values.metadata ?? {},
              createdAt: values.createdAt ?? now,
              updatedAt: values.updatedAt ?? now,
            };
            sessionRows.push(row);
            return [row];
          }
          if (table === sessionLifecycleCommands) {
            const row: typeof sessionLifecycleCommands.$inferSelect = {
              commandId: values.commandId ?? randomUUID(),
              commandType: values.commandType,
              source: values.source,
              status: values.status ?? 'queued',
              projectId: values.projectId,
              sessionId: values.sessionId ?? null,
              accountId: values.accountId,
              actorUserId: values.actorUserId ?? null,
              idempotencyKey: values.idempotencyKey ?? null,
              payload: values.payload ?? {},
              result: values.result ?? {},
              attempts: values.attempts ?? 0,
              availableAt: values.availableAt ?? now,
              lockedBy: values.lockedBy ?? null,
              lockedUntil: values.lockedUntil ?? null,
              lastError: values.lastError ?? null,
              createdAt: values.createdAt ?? now,
              updatedAt: values.updatedAt ?? now,
            };
            lifecycleCommandRows.push(row);
            return [row];
          }
          return [];
        },
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== sessionLifecycleCommands || !values.idempotencyKey) return [];
            const existing = lifecycleCommandRows.find(
              (row) => row.idempotencyKey === values.idempotencyKey,
            );
            if (existing) return [];
            const now = new Date('2026-01-02T00:00:00Z');
            const row: typeof sessionLifecycleCommands.$inferSelect = {
              commandId: values.commandId ?? randomUUID(),
              commandType: values.commandType,
              source: values.source,
              status: values.status ?? 'queued',
              projectId: values.projectId,
              sessionId: values.sessionId ?? null,
              accountId: values.accountId,
              actorUserId: values.actorUserId ?? null,
              idempotencyKey: values.idempotencyKey ?? null,
              payload: values.payload ?? {},
              result: values.result ?? {},
              attempts: values.attempts ?? 0,
              availableAt: values.availableAt ?? now,
              lockedBy: values.lockedBy ?? null,
              lockedUntil: values.lockedUntil ?? null,
              lastError: values.lastError ?? null,
              createdAt: values.createdAt ?? now,
              updatedAt: values.updatedAt ?? now,
            };
            lifecycleCommandRows.push(row);
            return [row];
          },
        }),
        onConflictDoUpdate: ({ set }: { set: any }) => {
          // Production code awaits this directly without calling .returning()
          // (`db.insert(...).values(...).onConflictDoUpdate({...})`). Make the
          // returned object both thenable AND `.returning()`-able so both
          // shapes work.
          const apply = (): any[] => {
            if (table === projectTriggerRuntime) {
              const idx = runtimeRows.findIndex(
                (r) => r.projectId === values.projectId && r.slug === values.slug,
              );
              const existing = idx >= 0 ? runtimeRows[idx] : undefined;
              // keepRunFailure sends CASE fragments that Postgres evaluates
              // against the existing row: a failed run keeps its status and
              // reason; any other row takes the written values.
              const plainSet = Object.fromEntries(Object.entries(set).filter(([, v]) => !is(v, SQL)));
              const keptFailure =
                existing?.runFailingSince != null
                  ? { lastStatus: existing.lastStatus, lastError: existing.lastError }
                  : {};
              const next = {
                ...existing,
                ...values,
                ...plainSet,
                ...keptFailure,
                projectId: values.projectId,
                slug: values.slug,
                lastFiredAt: (set.lastFiredAt ??
                  values.lastFiredAt ??
                  existing?.lastFiredAt ??
                  null) as Date | null,
                updatedAt: (set.updatedAt ?? values.updatedAt ?? new Date()) as Date,
              };
              if (idx >= 0) runtimeRows[idx] = next;
              else runtimeRows.push(next);
              return [next];
            }
            return [];
          };
          return {
            returning: async () => apply(),
            then: (resolve: (v: any) => unknown) => resolve(apply()),
            catch: () => undefined,
          };
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (setValues: any) => ({
        where: () => ({
          returning: async () => {
            if (table === sessionLifecycleCommands) {
              // The claim sets `attempts` and `result` with SQL expressions that
              // Postgres evaluates against the row; apply the plain values.
              const plain = Object.fromEntries(Object.entries(setValues).filter(([, v]) => !is(v, SQL)));
              lifecycleCommandRows = lifecycleCommandRows.map((row) => ({
                ...row,
                ...plain,
                ...(is(setValues.attempts, SQL) ? { attempts: row.attempts + 1 } : {}),
              }));
              return lifecycleCommandRows;
            }
            return [];
          },
          then: (resolve: (rows: any[]) => unknown) => {
            if (table === sessionLifecycleCommands) {
              lifecycleCommandRows = lifecycleCommandRows.map((row) => ({ ...row, ...setValues }));
            }
            if (table === projectSessions) {
              sessionRows = sessionRows.map((row) => ({
                ...row,
                ...(typeof setValues.createdBy === 'string'
                  ? { createdBy: setValues.createdBy }
                  : {}),
                ...(typeof setValues.visibility === 'string'
                  ? { visibility: setValues.visibility }
                  : {}),
              }));
            }
            return resolve([]);
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === projectTriggerRuntime) runtimeRows = [];
        if (table === sessionLifecycleCommands) lifecycleCommandRows = [];
      },
    }),
};
triggerDbMock.transaction = async (run: (tx: typeof triggerDbMock) => Promise<unknown>) =>
  run(triggerDbMock);

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: triggerDbMock,
}));

// Spread the real module: a wholesale stub drops every export another importer
// in the graph needs (#7936 added importers), and bun reports it as an
// unhandled `Export named ... not found` between tests.
const realTriggerExecutionStore = await import('../projects/trigger-execution-store');
mock.module('../projects/trigger-execution-store', () => ({
  ...realTriggerExecutionStore,
  claimDueScheduleSlots: async ({ now, limit }: { now: Date; limit: number }) => {
    const due = runtimeRows
      .filter(
        (row) =>
          row.enabled === true &&
          row.triggerType === 'cron' &&
          row.nextFireAt instanceof Date &&
          row.nextFireAt <= now &&
          projectRow.metadata?.triggers_paused !== true,
      )
      .slice(0, limit);
    return due.map((row) => {
      const scheduledFor = row.nextFireAt as Date;
      const execution = {
        executionId: randomUUID(),
        projectId: row.projectId,
        slug: row.slug,
        scheduleRevision: row.scheduleRevision,
        scheduledFor,
        status: 'queued',
        spec: row.scheduleSpec,
        payload: {
          cron: {
            schedule: row.scheduleSpec.cron,
            timezone: row.scheduleSpec.timezone,
            scheduled_for: scheduledFor.toISOString(),
            claimed_at: now.toISOString(),
          },
          trigger: { slug: row.slug, type: 'cron', kind: 'git' },
        },
        attempts: 0,
        availableAt: now,
        lockedBy: null,
        lockedUntil: null,
        sessionId: null,
        commandId: null,
        lastError: null,
        claimedAt: now,
        dispatchedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      triggerExecutionRows.push(execution);
      row.lastScheduledFor = scheduledFor;
      row.nextFireAt = row.scheduleSpec.runAt ? null : new Date(now.getTime() + 1_000);
      return { execution, inserted: true };
    });
  },
  claimTriggerExecutions: async ({
    now,
    workerId,
    limit,
  }: {
    now: Date;
    workerId: string;
    limit: number;
  }) =>
    triggerExecutionRows
      .filter(
        (row) =>
          (row.status === 'queued' && row.availableAt <= now) ||
          (row.status === 'running' && row.lockedUntil <= now),
      )
      .slice(0, limit)
      .map((row) => {
        row.status = 'running';
        row.attempts += 1;
        row.lockedBy = workerId;
        row.lockedUntil = new Date(now.getTime() + 120_000);
        return row;
      }),
  markTriggerExecutionDispatched: async ({ row, dispatchedAt }: any) => {
    row.dispatchedAt = dispatchedAt;
  },
  markTriggerExecutionSucceeded: async ({ row, completedAt, sessionId, commandId }: any) => {
    Object.assign(row, {
      status: 'succeeded',
      completedAt,
      sessionId: sessionId ?? null,
      commandId: commandId ?? null,
      lockedBy: null,
      lockedUntil: null,
    });
  },
  markTriggerExecutionSkipped: async ({ row, skippedAt, reason }: any) => {
    Object.assign(row, {
      status: 'skipped',
      completedAt: skippedAt,
      lastError: reason,
      lockedBy: null,
      lockedUntil: null,
    });
  },
  markTriggerExecutionFailed: async ({ row, failedAt, error, terminal: permanent }: any) => {
    const terminal = permanent === true || row.attempts >= 5;
    Object.assign(row, {
      status: terminal ? 'dead_lettered' : 'queued',
      completedAt: terminal ? failedAt : null,
      availableAt: new Date(failedAt.getTime() + 2_000),
      lastError: error,
      lockedBy: null,
      lockedUntil: null,
    });
    return terminal ? 'dead_lettered' : 'queued';
  },
  countUncatalogedTriggerProjects: async () =>
    runtimeRows.some((row) => !row.scheduleRevision) ? 1 : 0,
}));

// The alert edge is SQL (integration-trigger-alerts.test.ts); here only which
// failures raise or clear it.
const realTriggerAlerts = await import('../projects/lib/trigger-alerts');
mock.module('../projects/lib/trigger-alerts', () => ({
  ...realTriggerAlerts,
  raiseTriggerAlert: async (input: Record<string, unknown>) => {
    alertCalls.push({ kind: 'raise', input });
    return true;
  },
  clearTriggerAlert: async (input: Record<string, unknown>) => {
    alertCalls.push({ kind: 'clear', input });
    return false;
  },
}));

const realTriggerWatchers = await import('../projects/lib/trigger-watchers');
mock.module('../projects/lib/trigger-watchers', () => ({
  ...realTriggerWatchers,
  upsertTriggerWatcher: async (ref: Record<string, unknown>) => {
    if (watcherFailure) throw watcherFailure;
    watcherCalls.push({ kind: 'follow', ref });
  },
  deleteTriggerWatchers: async (ref: Record<string, unknown>) => {
    if (watcherFailure) throw watcherFailure;
    watcherCalls.push({ kind: 'drop', ref });
  },
}));

const realModelPreferences = await import('../repositories/model-preferences');
mock.module('../repositories/model-preferences', () => ({
  ...realModelPreferences,
  getAccountModelDefaults: async () => {
    if (modelDefaultsFailure) throw modelDefaultsFailure;
    return modelDefaults;
  },
}));

const realDefaultModel = await import('../llm-gateway/resolution/default-model');
mock.module('../llm-gateway/resolution/default-model', () => ({
  ...realDefaultModel,
  isModelServableForAccount: async () => true,
}));

const {
  drainSessionLifecycleQueue,
  drainTriggerExecutionQueue,
  projectsApp,
  projectWebhooksApp,
  registerAllProjectRoutes,
  runProjectTriggerSweep,
} = await import('../projects/index');
const { config } = await import('../config');
registerAllProjectRoutes();
const { resetRateLimiters } = await import('../middleware/rate-limit');

function createApp() {
  const app = new Hono();
  app.route('/v1/projects', projectsApp);
  app.route('/v1/webhooks', projectWebhooksApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

// ─── Manifest seeding helpers ──────────────────────────────────────────────
// All trigger config lives in `kortix.yaml` now. Tests seed manifest content
// directly into the in-memory repo — same shape the CRUD handlers read/write.
// Fixtures are hand-written v2 YAML; every string value goes through
// `JSON.stringify` so cron expressions (leading `*`), mustache prompts
// (`{{ ... }}`) etc. round-trip as valid YAML scalars without special-casing.

const MANIFEST_PREAMBLE = `kortix_version: 1\nproject:\n  name: Trigger Project\n`;

function seedManifest(...triggerBlocks: string[]) {
  const body = triggerBlocks.length === 0
    ? MANIFEST_PREAMBLE
    : `${MANIFEST_PREAMBLE}triggers:\n${triggerBlocks.join('\n')}\n`;
  repoFiles.set(MANIFEST_PATH, body);
}

/** Build a `triggers:` list-item block for a cron trigger. */
function cronEntry(opts: {
  slug: string;
  name?: string;
  cron: string;
  timezone?: string;
  agent?: string;
  model?: string;
  enabled?: boolean;
  prompt: string;
}): string {
  const lines = [`  - slug: ${JSON.stringify(opts.slug)}`];
  if (opts.name !== undefined) lines.push(`    name: ${JSON.stringify(opts.name)}`);
  lines.push('    type: cron');
  if (opts.agent !== undefined) lines.push(`    agent: ${JSON.stringify(opts.agent)}`);
  if (opts.model !== undefined) lines.push(`    model: ${JSON.stringify(opts.model)}`);
  if (opts.enabled !== undefined) lines.push(`    enabled: ${opts.enabled}`);
  lines.push(`    cron: ${JSON.stringify(opts.cron)}`);
  if (opts.timezone !== undefined) lines.push(`    timezone: ${JSON.stringify(opts.timezone)}`);
  lines.push(`    prompt: ${JSON.stringify(opts.prompt)}`);
  return lines.join('\n');
}

function seedRuntimeCron(opts: {
  slug: string;
  prompt: string;
  nextFireAt: Date;
  sessionMode?: string;
}) {
  runtimeRows.push({
    projectId: PROJECT_ID,
    slug: opts.slug,
    lastFiredAt: null,
    lastStatus: null,
    lastError: null,
    lastAttemptAt: null,
    ownerUserId: null,
    description: null,
    strategy: 'runtime' as const,
    egressPolicy: null,
    handlePrefix: null,
    rotatedAt: null,
    strategyLocked: false,
    sessionId: null,
    triggerType: 'cron',
    enabled: true,
    scheduleCron: '* * * * * *',
    scheduleRunAt: null,
    scheduleTimezone: 'UTC',
    scheduleRevision: 'a'.repeat(64),
    scheduleSpec: {
      slug: opts.slug,
      path: `kortix.yaml#triggers.${opts.slug}`,
      name: opts.slug,
      type: 'cron',
      agent: 'default',
      model: null,
      enabled: true,
      promptTemplate: opts.prompt,
      cron: '* * * * * *',
      runAt: null,
      timezone: 'UTC',
      secretEnv: null,
      sessionMode: opts.sessionMode ?? 'fresh',
      pinnedSessionId: null,
      sessionKey: null,
      filter: null,
    },
    nextFireAt: opts.nextFireAt,
    lastScheduledFor: null,
    updatedAt: opts.nextFireAt,
  });
}

/** Build a `triggers:` list-item block for a webhook trigger. */
function webhookEntry(opts: {
  slug: string;
  name?: string;
  secretEnv: string;
  agent?: string;
  enabled?: boolean;
  sessionMode?: string;
  prompt: string;
}): string {
  const lines = [`  - slug: ${JSON.stringify(opts.slug)}`];
  if (opts.name !== undefined) lines.push(`    name: ${JSON.stringify(opts.name)}`);
  lines.push('    type: webhook');
  if (opts.sessionMode !== undefined) lines.push(`    session_mode: ${opts.sessionMode}`);
  if (opts.agent !== undefined) lines.push(`    agent: ${JSON.stringify(opts.agent)}`);
  if (opts.enabled !== undefined) lines.push(`    enabled: ${opts.enabled}`);
  lines.push(`    secret_env: ${JSON.stringify(opts.secretEnv)}`);
  lines.push(`    prompt: ${JSON.stringify(opts.prompt)}`);
  return lines.join('\n');
}

describe('git-backed triggers — runtime fire paths', () => {
  beforeEach(() => resetState());

  test('manual fire without overrides resolves the project model and selected agent before provisioning', async () => {
    modelDefaults.projects[PROJECT_ID] = 'glm-5.3-flash';
    projectRow.metadata = {
      default_agent: 'asana-refresher',
      experimental: { llm_gateway: true },
    };
    seedManifest(cronEntry({
      slug: 'daily',
      name: 'Daily',
      cron: '* * * * * *',
      prompt: 'Run at {{ fired_at }}',
    }));

    const app = createApp();
    const res = await app.request(`/v1/projects/${PROJECT_ID}/triggers/daily/fire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(202);

    await new Promise((r) => setTimeout(r, 0));
    expect(sandboxProvisionCalls).toBe(1);
    expect(sessionRows.at(-1)?.agentName).toBe('asana-refresher');
    expect(sessionRows.at(-1)?.metadata).toMatchObject({
      opencode_model: 'kortix/glm-5.3-flash',
      opencode_model_source: 'project',
    });
  });

  test('cron sweep fires due git-backed triggers', async () => {
    seedManifest(cronEntry({
      slug: 'sweep',
      name: 'Sweep',
      cron: '* * * * * *',
      prompt: 'Sweep run',
    }));
    const scheduledFor = new Date('2026-01-01T00:00:30Z');
    seedRuntimeCron({ slug: 'sweep', prompt: 'Sweep run', nextFireAt: scheduledFor });

    const result = await runProjectTriggerSweep(scheduledFor);
    expect(result).toMatchObject({ scanned: 1, fired: 0, failed: 0 });
    expect(await drainTriggerExecutionQueue(scheduledFor)).toMatchObject({
      fired: 1,
      queued: 0,
      failed: 0,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionEnv?.KORTIX_INITIAL_PROMPT).toBeUndefined();
    // A good fire ends a fire-failure alert streak.
    expect(alertCalls).toEqual([{ kind: 'clear', input: { projectId: PROJECT_ID, slug: 'sweep', source: 'fire' } }]);
  });

  test('cron sweep under backpressure queues and records accepted fire', async () => {
    seedManifest(cronEntry({
      slug: 'sweep',
      name: 'Sweep',
      cron: '* * * * * *',
      prompt: 'Sweep run',
    }));
    const firstSlot = new Date('2026-01-01T00:00:30Z');
    seedRuntimeCron({ slug: 'sweep', prompt: 'Sweep run', nextFireAt: firstSlot });
    provisioningSessionCount = 3;

    const result = await runProjectTriggerSweep(firstSlot);
    expect(result).toMatchObject({ scanned: 1, fired: 0, queued: 0, failed: 0 });
    expect(await drainTriggerExecutionQueue(firstSlot)).toMatchObject({
      fired: 0,
      queued: 1,
      failed: 0,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sandboxProvisionCalls).toBe(0);
    expect(runtimeRows).toHaveLength(1);
    expect(runtimeRows[0]!.lastFiredAt).toBeTruthy();
    expect(triggerExecutionRows[0]?.scheduledFor.toISOString()).toBe(
      '2026-01-01T00:00:30.000Z',
    );
    // A create still queued has reached no session: the streak stays open.
    expect(alertCalls).toEqual([]);

    provisioningSessionCount = 0;
    const secondSlot = new Date('2026-01-01T00:00:31Z');
    const retry = await runProjectTriggerSweep(secondSlot);
    expect(retry).toMatchObject({ scanned: 1, fired: 0, queued: 0, failed: 0 });
    expect(await drainTriggerExecutionQueue(secondSlot)).toMatchObject({
      fired: 1,
      queued: 0,
      failed: 0,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sandboxProvisionCalls).toBe(1);
    expect(runtimeRows).toHaveLength(1);
    expect(triggerExecutionRows[1]?.scheduledFor.toISOString()).toBe(
      '2026-01-01T00:00:31.000Z',
    );
  });

  test('reuse trigger cron sweep records fired (not queued) for a prompt-enqueued delivery handoff', async () => {
    seedManifest(cronEntry({
      slug: 'reuse-stale',
      name: 'Reuse Stale',
      cron: '* * * * * *',
      prompt: 'Reuse sweep run',
    }));
    const scheduledFor = new Date('2026-01-01T00:00:30Z');
    seedRuntimeCron({
      slug: 'reuse-stale',
      prompt: 'Reuse sweep run',
      nextFireAt: scheduledFor,
      sessionMode: 'reuse',
    });
    // Pre-seed a reusable session so the fire path finds it and enqueues (rather
    // than creating a fresh session, which would return `fired`).
    sessionRows.push({
      labels: [],
      sessionId: 'sess-reuse',
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      branchName: 'main',
      baseRef: 'main',
      sandboxProvider: 'daytona',
      sandboxId: null,
      sandboxUrl: null,
      runtimeSessionId: null,
      agentName: 'default',
      status: 'stopped',
      error: null,
      createdBy: USER_ID,
      visibility: 'private',
      origin: 'system',
      originRef: null,
      parentSessionId: null,
      initiatorType: null,
      initiatorId: null,
      secretsAllowlist: null,
      requiredConnectors: null,
      connectorBindingsInheritUnbound: false,
      connectorBindingsConfigured: false,
      metadata: { trigger_slug: 'reuse-stale', trigger_kind: 'git' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await runProjectTriggerSweep(scheduledFor);
    expect(result).toMatchObject({ scanned: 1, fired: 0, failed: 0 });
    expect(await drainTriggerExecutionQueue(scheduledFor)).toMatchObject({
      fired: 0,
      queued: 1,
      failed: 0,
    });
    await new Promise((r) => setTimeout(r, 0));
    // The execution drain calls `markGitTriggerFired` — the key
    // assertion: `lastStatus` is `'fired'`, not `'queued'`, even though
    // `fireGitTrigger` returned `{ status: 'queued', reason: 'prompt queued
    // for delivery' }`. The `executeTriggerExecution` path now maps the
    // delivery handoff to `fired` so the reliability operator's
    // `QUEUED_OVER_15M` guard does not flag every `session_mode: reuse`
    // trigger permanently.
    expect(runtimeRows).toHaveLength(1);
    expect(runtimeRows[0]!.lastStatus).toBe('fired');
    expect(runtimeRows[0]!.lastFiredAt).toBeTruthy();
    expect(sandboxProvisionCalls).toBe(0);
    // Shown as fired, but the prompt has not run: its delivery ends a streak (KRTX-1742).
    expect(alertCalls.filter((call) => call.kind === 'clear')).toEqual([]);
  });

  test('a cron slot refused for an empty wallet dead-letters at once and raises the fire alert once', async () => {
    seedManifest(cronEntry({ slug: 'wallet', name: 'Wallet', cron: '* * * * * *', prompt: 'Report' }));
    const slot = new Date('2026-01-01T00:00:30Z');
    seedRuntimeCron({ slug: 'wallet', prompt: 'Report', nextFireAt: slot });
    walletBalance = 0;
    const billingWasEnabled = config.KORTIX_BILLING_INTERNAL_ENABLED;
    config.KORTIX_BILLING_INTERNAL_ENABLED = true;
    try {
      await runProjectTriggerSweep(slot);
      expect(await drainTriggerExecutionQueue(slot)).toMatchObject({ fired: 0, queued: 0, failed: 1 });
    } finally {
      config.KORTIX_BILLING_INTERNAL_ENABLED = billingWasEnabled;
    }

    expect(triggerExecutionRows[0]).toMatchObject({ status: 'dead_lettered', attempts: 1 });
    expect(sandboxProvisionCalls).toBe(0);
    // The inline create command dead-lettered too; only the slot alerts.
    expect(lifecycleCommandRows.map((row) => row.status)).toEqual(['dead_lettered']);
    expect(alertCalls).toEqual([
      {
        kind: 'raise',
        input: { projectId: PROJECT_ID, slug: 'wallet', source: 'fire', error: triggerExecutionRows[0]!.lastError },
      },
    ]);
  });

  test('a failed attempt the cron retries raises nothing; the fifth dead-letters and raises once', async () => {
    seedManifest(cronEntry({ slug: 'flaky', name: 'Flaky', cron: '* * * * * *', prompt: 'Report' }));
    const slot = new Date('2026-01-01T00:00:30Z');
    seedRuntimeCron({ slug: 'flaky', prompt: 'Report', nextFireAt: slot });
    // No owner to run as: a failure with no permanent code, so it retries.
    automationActor = null;

    await runProjectTriggerSweep(slot);
    expect(await drainTriggerExecutionQueue(slot)).toMatchObject({ queued: 1, failed: 0 });
    expect(runtimeRows[0]).toMatchObject({ lastStatus: 'failed' });
    expect(alertCalls).toEqual([]);

    // Each retry is due 2 s after its failure; claim each one well after that.
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await drainTriggerExecutionQueue(new Date(Date.now() + attempt * 60_000));
    }
    expect(triggerExecutionRows[0]).toMatchObject({ status: 'dead_lettered', attempts: 5 });
    expect(alertCalls).toEqual([
      {
        kind: 'raise',
        input: {
          projectId: PROJECT_ID,
          slug: 'flaky',
          source: 'fire',
          error: 'No account owner available to own the session',
        },
      },
    ]);
  });

  test('the person who creates or edits a trigger follows it; deleting it drops its followers', async () => {
    seedManifest();
    testAuthType = 'supabase';
    const app = createApp();
    const created = await app.request(`/v1/projects/${PROJECT_ID}/triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nightly', type: 'cron', cron: '0 0 2 * * *', prompt_template: 'Report' }),
    });
    expect(created.status).toBe(201);
    const edited = await app.request(`/v1/projects/${PROJECT_ID}/triggers/nightly`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_template: 'Report again' }),
    });
    expect(edited.status).toBe(200);
    const deleted = await app.request(`/v1/projects/${PROJECT_ID}/triggers/nightly`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);

    const follow = { accountId: ACCOUNT_ID, projectId: PROJECT_ID, slug: 'nightly', userId: USER_ID };
    expect(watcherCalls).toEqual([
      { kind: 'follow', ref: follow },
      { kind: 'follow', ref: follow },
      { kind: 'drop', ref: { projectId: PROJECT_ID, slug: 'nightly' } },
    ]);
  });

  test('an API key that creates a trigger names no person, so nobody follows it', async () => {
    seedManifest();
    testAuthType = 'apiKey';
    const created = await createApp().request(`/v1/projects/${PROJECT_ID}/triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nightly', type: 'cron', cron: '0 0 2 * * *', prompt_template: 'Report' }),
    });
    expect(created.status).toBe(201);
    expect(watcherCalls).toEqual([]);
  });

  test('a manual fire that fails raises the fire alert', async () => {
    seedManifest(cronEntry({ slug: 'manual', name: 'Manual', cron: '* * * * * *', prompt: 'Report' }));
    automationActor = null;
    const res = await createApp().request(`/v1/projects/${PROJECT_ID}/triggers/manual/fire`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(alertCalls).toEqual([
      {
        kind: 'raise',
        input: {
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          slug: 'manual',
          source: 'fire',
          error: 'No account owner available to own the session',
        },
      },
    ]);
  });

  test('a webhook fire that fails raises the fire alert', async () => {
    seedManifest(webhookEntry({ slug: 'hook', name: 'Hook', secretEnv: 'HOOK_SECRET', prompt: 'New {{ body.action }}' }));
    secretValues.set('HOOK_SECRET', 'shhh');
    automationActor = null;
    const rawBody = JSON.stringify({ action: 'opened' });
    const res = await createApp().request(`/v1/webhooks/projects/${PROJECT_ID}/hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody, 'shhh'),
        'X-Kortix-Delivery-Id': 'failing-delivery-1',
      },
      body: rawBody,
    });
    expect(res.status).toBe(500);
    expect(alertCalls).toEqual([
      {
        kind: 'raise',
        input: {
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          slug: 'hook',
          source: 'fire',
          error: 'No account owner available to own the session',
        },
      },
    ]);
  });

  test('a bad signature refreshes the manifest mirror at most once per budget window, and a missing one never reads it', async () => {
    seedManifest(webhookEntry({
      slug: 'hook',
      name: 'Hook',
      secretEnv: 'HOOK_SECRET',
      prompt: 'New {{ body.action }}',
    }));
    secretValues.set('HOOK_SECRET', 'shhh');
    const app = createApp();

    const rawBody = JSON.stringify({ action: 'opened' });
    const missing = await app.request(`/v1/webhooks/projects/${PROJECT_ID}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    });
    expect(missing.status).toBe(401);
    expect(manifestReadCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);

    const wrong = await app.request(`/v1/webhooks/projects/${PROJECT_ID}/hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody, 'wrong-secret'),
      },
      body: rawBody,
    });
    expect(wrong.status).toBe(401);
    expect(mirrorInvalidationCalls).toBe(1);
    expect(manifestReadCalls).toBe(1);

    const repeated = await app.request(`/v1/webhooks/projects/${PROJECT_ID}/hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody, 'another-wrong-secret'),
      },
      body: rawBody,
    });
    expect(repeated.status).toBe(401);
    expect(mirrorInvalidationCalls).toBe(1);
    expect(manifestReadCalls).toBe(2);
  });

  test('webhook fires with a valid HMAC spawn a session', async () => {
    seedManifest(webhookEntry({
      slug: 'hook',
      name: 'Hook',
      secretEnv: 'HOOK_SECRET',
      prompt: 'New {{ body.action }}',
    }));
    secretValues.set('HOOK_SECRET', 'shhh');
    const app = createApp();

    const rawBody = JSON.stringify({ action: 'opened' });
    const res = await app.request(`/v1/webhooks/projects/${PROJECT_ID}/hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody, 'shhh'),
        'X-Kortix-Delivery-Id': 'delivery-1',
      },
      body: rawBody,
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('fired');
    expect(secretConsumerReads[0]).toMatchObject({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: 'HOOK_SECRET',
      consumer: 'connector',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionEnv?.KORTIX_INITIAL_PROMPT).toBeUndefined();

    const duplicate = await app.request(`/v1/webhooks/projects/${PROJECT_ID}/hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody, 'shhh'),
        'X-Kortix-Delivery-Id': 'delivery-1',
      },
      body: rawBody,
    });
    expect(duplicate.status).toBe(202);
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.status).toBe('deduped');
    await new Promise((r) => setTimeout(r, 0));
    expect(sandboxProvisionCalls).toBe(1);
  });

  test('webhook trigger queues under backpressure and queue drain creates one session', async () => {
    seedManifest(webhookEntry({
      slug: 'hook',
      name: 'Hook',
      secretEnv: 'HOOK_SECRET',
      prompt: 'New {{ body.action }}',
    }));
    secretValues.set('HOOK_SECRET', 'shhh');
    provisioningSessionCount = 3;
    const app = createApp();

    const rawBody = JSON.stringify({ action: 'opened' });
    const res = await app.request(`/v1/webhooks/projects/${PROJECT_ID}/hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody, 'shhh'),
        'X-Kortix-Delivery-Id': 'queued-delivery-1',
      },
      body: rawBody,
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.command_id).toBeTruthy();
    expect(sandboxProvisionCalls).toBe(0);
    expect(lifecycleCommandRows).toHaveLength(1);
    expect(lifecycleCommandRows[0]!.status).toBe('queued');

    provisioningSessionCount = 0;
    const drained = await drainSessionLifecycleQueue({ workerId: 'test-worker', limit: 1 });
    expect(drained).toEqual({ claimed: 1, succeeded: 1, failed: 0, queued: 0, released: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionEnv?.KORTIX_INITIAL_PROMPT).toBeUndefined();
    expect(lifecycleCommandRows[0]!.status).toBe('succeeded');
    expect(lifecycleCommandRows[0]!.sessionId).toBeTruthy();
  });

  describe('automation alerts (KRTX-1742)', () => {
    const fireAlert = (input: Record<string, unknown>) => ({ projectId: PROJECT_ID, slug: 'hook', source: 'fire', ...input });

    async function postHook(deliveryId: string) {
      seedManifest(webhookEntry({ slug: 'hook', name: 'Hook', secretEnv: 'HOOK_SECRET', prompt: 'New {{ body.action }}' }));
      secretValues.set('HOOK_SECRET', 'shhh');
      const rawBody = JSON.stringify({ action: 'opened' });
      return createApp().request(`/v1/webhooks/projects/${PROJECT_ID}/hook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Kortix-Signature': sign(rawBody, 'shhh'),
          'X-Kortix-Delivery-Id': deliveryId,
        },
        body: rawBody,
      });
    }

    test('a webhook create queued under backpressure ends no streak; its drained create does', async () => {
      provisioningSessionCount = 3;
      const res = await postHook('queued-alert-1');
      expect(res.status).toBe(202);
      expect((await res.json()).status).toBe('queued');
      expect(runtimeRows[0]).toMatchObject({ lastStatus: 'fired' });
      expect(alertCalls).toEqual([]);

      provisioningSessionCount = 0;
      await drainSessionLifecycleQueue({ workerId: 'test-worker', limit: 1 });
      expect(lifecycleCommandRows[0]!.status).toBe('succeeded');
      expect(alertCalls).toEqual([{ kind: 'clear', input: fireAlert({ accountId: ACCOUNT_ID }) }]);
    });

    test('a webhook prompt queued into the reused session ends no streak', async () => {
      seedManifest(webhookEntry({ slug: 'hook', name: 'Hook', secretEnv: 'HOOK_SECRET', sessionMode: 'reuse', prompt: 'New {{ body.action }}' }));
      secretValues.set('HOOK_SECRET', 'shhh');
      sessionRows.push({
        ...sessionRowsTemplate(),
        sessionId: 'sess-hook-reuse',
        metadata: { trigger_slug: 'hook', trigger_kind: 'git' },
      });
      const rawBody = JSON.stringify({ action: 'opened' });
      const res = await createApp().request(`/v1/webhooks/projects/${PROJECT_ID}/hook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kortix-Signature': sign(rawBody, 'shhh'), 'X-Kortix-Delivery-Id': 'reuse-alert-1' },
        body: rawBody,
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ status: 'queued', reason: 'prompt queued for delivery', session_id: 'sess-hook-reuse' });
      expect(runtimeRows[0]).toMatchObject({ lastStatus: 'fired' });
      expect(alertCalls.filter((call) => call.kind === 'clear')).toEqual([]);
    });

    test('a manual fire that only queues ends no streak', async () => {
      seedManifest(cronEntry({ slug: 'manual', name: 'Manual', cron: '* * * * * *', prompt: 'Report' }));
      provisioningSessionCount = 3;
      const res = await createApp().request(`/v1/projects/${PROJECT_ID}/triggers/manual/fire`, { method: 'POST' });
      expect(res.status).toBe(202);
      expect((await res.json()).status).toBe('queued');
      expect(alertCalls).toEqual([]);
    });

    test('a webhook create that throws goes back to the queue and alerts nobody yet', async () => {
      providerFailure = new Error('git clone timed out after 90000ms');
      const res = await postHook('throwing-delivery-1');
      expect(res.status).toBe(500);
      expect(lifecycleCommandRows.map((row) => row.status)).toEqual(['queued']);
      expect(alertCalls).toEqual([]);
    });

    test('a webhook create that answers 503 is not requeued, so it alerts', async () => {
      projectRow.metadata = { experimental: { llm_gateway: true } };
      modelDefaultsFailure = new Error('model defaults unavailable');
      const res = await postHook('503-delivery-1');
      expect(res.status).toBe(500);
      expect(lifecycleCommandRows.map((row) => row.status)).toEqual(['dead_lettered']);
      expect(alertCalls).toEqual([
        { kind: 'raise', input: fireAlert({ accountId: ACCOUNT_ID, error: 'The session default model could not be resolved' }) },
      ]);
    });

    test('a failed watcher write does not fail the trigger create or delete', async () => {
      seedManifest();
      testAuthType = 'supabase';
      watcherFailure = new Error('connection terminated');
      const app = createApp();
      const created = await app.request(`/v1/projects/${PROJECT_ID}/triggers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nightly', type: 'cron', cron: '0 0 2 * * *', prompt_template: 'Report' }),
      });
      expect(created.status).toBe(201);
      const deleted = await app.request(`/v1/projects/${PROJECT_ID}/triggers/nightly`, { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      expect(repoFiles.get(MANIFEST_PATH)).not.toContain('nightly');
    });
  });

});

/** A stopped session row the trigger created earlier; override what the test needs. */
function sessionRowsTemplate(): typeof projectSessions.$inferSelect {
  return {
    labels: [],
    sessionId: 'sess-template',
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    branchName: 'main',
    baseRef: 'main',
    sandboxProvider: 'daytona',
    sandboxId: null,
    sandboxUrl: null,
    runtimeSessionId: null,
    agentName: 'default',
    status: 'stopped',
    error: null,
    createdBy: USER_ID,
    visibility: 'private',
    origin: 'system',
    originRef: null,
    parentSessionId: null,
    initiatorType: null,
    initiatorId: null,
    secretsAllowlist: null,
    requiredConnectors: null,
    connectorBindingsInheritUnbound: false,
    connectorBindingsConfigured: false,
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}
