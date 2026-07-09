/**
 * Production wiring for the executor router — DB-backed ExecutorRouterDeps +
 * GatewayDeps. Access lives on the connector; credentials are split per (connector,
 * user). The pure logic (gateway/share/execute/policy/normalize) is tested; this
 * is the glue to Postgres + the credential store + Pipedream. See docs/specs/executor.md.
 */
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  executorConnectorActions,
  executorConnectorPolicies,
  executorConnectors,
  executorExecutions,
  executorProjectPolicies,
  executorProjectSettings,
  projectSessions,
  projects,
  sessionToolApprovals,
} from '@kortix/db';
import { db } from '../shared/db';
import { validateAccountToken } from '../repositories/account-tokens';
import { authorize } from '../iam';
import { loadProjectForUser } from '../projects/lib/access';
import { resolveShareSubject } from './share';
import { credentialExists, deleteCredential, resolveCredentialValue } from './credentials';
import {
  resolveEffectiveAction,
  type DefaultMode,
  type Policy,
} from './policy';
import { syncProjectConnectors } from './sync';
import { executeComputerCall } from '../tunnel/core/rpc-core';
import {
  loadAgentMailApiKeyForProject,
  loadAgentMailApiKeyForInbox,
  loadAgentMailInstall,
  loadMeetInstall,
  loadMeetTokenForProject,
  loadSlackInstall,
  loadSlackTokenForProject,
} from '../channels/install-store';
import { resolveAgentMailApiKey } from '../channels/agentmail-api';
import { meetRealtimeJoinPatch } from '../channels/meet-realtime';
import { deriveWakeWord, resolveProjectBotName } from '../channels/meet-voices';
import { hideSupersededSlack } from './channel-rules';
import { agentMayUseConnector } from '../iam/agent-scope';
import {
  finalizePipedreamConnection,
  pipedreamConfigured,
  pipedreamConnectUrl,
  runPipedreamAction,
  runPipedreamProxy,
  browsePipedreamApps,
  verifyWebhookSig,
} from './pipedream';
import {
  deleteConnectorFromManifest,
  getProjectPoliciesFromManifest,
  setConnectorCredentialShared,
  setConnectorCredentialModeInManifest,
  setConnectorSensitiveInManifest,
  setConnectorNameInManifest,
  getConnectorPoliciesFromManifest,
  getConnectorConfigFromManifest,
  setConnectorPoliciesInManifest,
  setProjectPoliciesInManifest,
  upsertConnectorInManifest,
  type ConnectorDraft,
} from './manifest-crud';
import type { ActionBinding, Risk } from './types';
import type { ChannelPlatform } from '../projects/connectors';
import type { ExecutorAuth, FetchImpl } from './execute';
import type { GatewayAction, GatewayConnector, GatewayDeps } from './gateway';
import type {
  AdminConnectorView,
  CatalogConnector,
  ExecutorPrincipal,
  ExecutorRouterDeps,
} from './router';

const DEFAULT_AUTH: ExecutorAuth = { type: 'none', in: 'header', name: null, prefix: null };
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Poll a `pending_approval` execution until a human resolves it (approve/deny)
 * or `timeoutMs` elapses. Powers the gateway's in-session pause: a require-
 * approval call blocks here so the agent's turn waits, then resumes on approve.
 * The resolve endpoint stamps `resolvedAt` with a terminal status (`denied` for
 * a refusal, otherwise approved).
 */
export async function waitForApprovalDecision(
  executionId: string,
  timeoutMs: number,
): Promise<'approved' | 'denied' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 1000;
  while (Date.now() < deadline) {
    const [row] = await db
      .select({ status: executorExecutions.status, resolvedAt: executorExecutions.resolvedAt })
      .from(executorExecutions)
      .where(eq(executorExecutions.executionId, executionId))
      .limit(1);
    if (row?.resolvedAt) return row.status === 'denied' ? 'denied' : 'approved';
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return 'timeout';
}

/** "Allow for this session" check (gateway hot path): is this exact
 *  (session, connector, action) already session-approved? A `*` actionPath row
 *  is the "allow everything for this session" grant (resolve scope
 *  `session_all` records one per enabled connector) and matches any action. */
export async function isSessionToolApproved(
  sessionId: string,
  connectorId: string,
  actionPath: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: sessionToolApprovals.id })
    .from(sessionToolApprovals)
    .where(
      and(
        eq(sessionToolApprovals.sessionId, sessionId),
        eq(sessionToolApprovals.connectorId, connectorId),
        inArray(sessionToolApprovals.actionPath, [actionPath, '*']),
      ),
    )
    .limit(1);
  return !!row;
}

/** How long an unconsumed human approve stays claimable by a fresh call. Long
 *  enough for the "agent gave up → approve lands → nudge/`continue` retries"
 *  round-trip, short enough that a stale yes can't silently authorize a much
 *  later call. */
const APPROVAL_CARRYOVER_WINDOW_MS = 15 * 60 * 1000;

/**
 * Claim a recent approve of (session, connector, action) that no held/poll
 * request consumed — see GatewayDeps.consumeApprovedExecution. Atomic via the
 * guarded UPDATE on the not-yet-consumed marker: two racing calls can't both
 * claim the same grant. Newest grant first; one claim per approve.
 */
export async function consumeApprovedExecution(input: {
  sessionId: string;
  connectorId: string;
  actionPath: string;
}): Promise<boolean> {
  const cutoff = new Date(Date.now() - APPROVAL_CARRYOVER_WINDOW_MS);
  const candidates = await db
    .select({
      executionId: executorExecutions.executionId,
      resultSummary: executorExecutions.resultSummary,
    })
    .from(executorExecutions)
    .where(
      and(
        eq(executorExecutions.sessionId, input.sessionId),
        eq(executorExecutions.connectorId, input.connectorId),
        eq(executorExecutions.actionPath, input.actionPath),
        // A human-approved gate: the resolve endpoint flips the pending row to
        // `ok` + stamps approvedBy. Rows from actual runs never have approvedBy.
        eq(executorExecutions.status, 'ok'),
        isNotNull(executorExecutions.approvedBy),
        gt(executorExecutions.resolvedAt, cutoff),
        sql`${executorExecutions.resultSummary} ->> 'decision' = 'approve'`,
        sql`${executorExecutions.resultSummary} ->> 'consumed_at' IS NULL`,
      ),
    )
    .orderBy(desc(executorExecutions.resolvedAt))
    .limit(3);
  for (const candidate of candidates) {
    const claimed = await db
      .update(executorExecutions)
      .set({
        resultSummary: {
          ...(typeof candidate.resultSummary === 'object' && candidate.resultSummary
            ? candidate.resultSummary
            : {}),
          consumed_at: new Date().toISOString(),
        },
      })
      .where(
        and(
          eq(executorExecutions.executionId, candidate.executionId),
          sql`${executorExecutions.resultSummary} ->> 'consumed_at' IS NULL`,
        ),
      )
      .returning({ id: executorExecutions.executionId });
    if (claimed.length > 0) return true;
  }
  return false;
}

/** Mark an approve consumed by the held/poll request that resumed on it — see
 *  GatewayDeps.markApprovalConsumed. */
export async function markApprovalConsumed(executionId: string): Promise<void> {
  await db
    .update(executorExecutions)
    .set({
      resultSummary: sql`coalesce(${executorExecutions.resultSummary}, '{}'::jsonb) || jsonb_build_object('consumed_at', ${new Date().toISOString()}::text)`,
    })
    .where(
      and(
        eq(executorExecutions.executionId, executionId),
        sql`${executorExecutions.resultSummary} ->> 'consumed_at' IS NULL`,
      ),
    );
}

/** Record an "allow for the rest of this session" grant (resolve endpoint).
 *  Idempotent: a repeat of the same (session, connector, action) is a no-op. */
export async function recordSessionToolApproval(input: {
  sessionId: string;
  projectId: string;
  connectorId: string;
  actionPath: string;
  grantedBy: string | null;
}): Promise<void> {
  await db
    .insert(sessionToolApprovals)
    .values({
      sessionId: input.sessionId,
      projectId: input.projectId,
      connectorId: input.connectorId,
      actionPath: input.actionPath,
      grantedBy: input.grantedBy,
    })
    .onConflictDoNothing();
}

type ConnectorRow = typeof executorConnectors.$inferSelect;

function authOf(row: ConnectorRow): { auth: ExecutorAuth; hasAuth: boolean } {
  const cfg = (row.config ?? {}) as Record<string, any>;
  const auth: ExecutorAuth = cfg.auth
    ? { type: cfg.auth.type, in: cfg.auth.in ?? 'header', name: cfg.auth.name ?? null, prefix: cfg.auth.prefix ?? null }
    : DEFAULT_AUTH;
  const hasAuth = row.providerType === 'pipedream' || auth.type !== 'none';
  return { auth, hasAuth };
}

function baseUrlOf(row: ConnectorRow): string | null {
  const cfg = (row.config ?? {}) as Record<string, any>;
  switch (row.providerType) {
    case 'openapi': return cfg.server ?? null;
    case 'http': return cfg.baseUrl ?? null;
    case 'graphql': return cfg.endpoint ?? null;
    case 'mcp': return cfg.url ?? null;
    case 'channel': return cfg.baseUrl ?? null;
    // computer: no base URL — the gateway relays via the tunnel core, not HTTP.
    case 'computer': return null;
    default: return null;
  }
}

/* ─── channel connectors: credential = the platform install token ──────────────
 * A channel connector has no executor_credentials row — its credential is the
 * existing platform install (resolved server-side, always fresh). These three
 * helpers are the single home for that dispatch; everything else stays generic.
 */
function channelPlatform(config: ConnectorRow['config'] | null): string | null {
  return (config as Record<string, any> | null)?.platform ?? null;
}

async function channelToken(projectId: string, platform: string | null, slug?: string | null): Promise<string | null> {
  if (platform === 'slack') return loadSlackTokenForProject(projectId);
  if (platform === 'email') return resolveAgentMailApiKey(await loadAgentMailApiKeyForProject(projectId, slug));
  if (platform === 'meet') return loadMeetTokenForProject(projectId);
  return null;
}

/** Cheap "is it connected?" — the install exists (no decrypt). */
async function channelInstalled(projectId: string, platform: string | null, slug?: string | null): Promise<boolean> {
  if (platform === 'slack') return (await loadSlackInstall(projectId).catch(() => null)) != null;
  if (platform === 'email') return (await loadAgentMailInstall(projectId, slug).catch(() => null)) != null;
  if (platform === 'meet') return (await loadMeetInstall(projectId).catch(() => null)) != null;
  return false;
}

/**
 * Whether a connector's credential is present for `userId` — channel connectors
 * check their platform install; everyone else checks executor_credentials. One
 * place so the catalog + admin listings don't each re-branch on provider.
 */
async function connectorConnected(row: ConnectorRow, userId: string | null): Promise<boolean> {
  return row.providerType === 'channel'
    ? channelInstalled(row.projectId, channelPlatform(row.config), row.slug)
    : credentialExists(row.connectorId, userId);
}

function toGatewayConnector(row: ConnectorRow): GatewayConnector {
  const { auth, hasAuth } = authOf(row);
  return {
    connectorId: row.connectorId,
    slug: row.slug,
    provider: row.providerType,
    platform: channelPlatform(row.config),
    baseUrl: baseUrlOf(row),
    auth,
    hasAuth,
    // `per_user` was removed 2026-07-05; every row is `shared` (DB-enforced by
    // a CHECK constraint), so this is a defensive cast, not a live branch.
    credentialMode: 'shared',
    enabled: row.enabled,
    sensitive: (row.config as { sensitive?: unknown } | null)?.sensitive === true,
  };
}

const nodeFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { status: res.status, ok: res.ok, text: () => res.text() };
};

function makeDbGatewayDeps(): GatewayDeps {
  return {
    loadConnectorBySlug: async (projectId, slug) => {
      const [row] = await db
        .select()
        .from(executorConnectors)
        .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
        .limit(1);
      if (!row) return null;
      return toGatewayConnector(row);
    },
    loadAction: async (connectorId, relPath) => {
      const [a] = await db
        .select()
        .from(executorConnectorActions)
        .where(and(eq(executorConnectorActions.connectorId, connectorId), eq(executorConnectorActions.path, relPath)))
        .limit(1);
      if (!a) return null;
      return {
        path: a.path,
        relPath: a.path,
        inputSchema: a.inputSchema ?? null,
        risk: a.risk as Risk,
        binding: a.binding as unknown as ActionBinding,
      } satisfies GatewayAction;
    },
    resolveCredential: async (connector, userId) => {
      // Channel connectors resolve to their platform install token (server-side);
      // the provider is already in hand, so only the channel path does a lookup —
      // every other connector takes the original executor_credentials path.
      if (connector.provider === 'channel') {
        const [row] = await db
          .select({ projectId: executorConnectors.projectId, slug: executorConnectors.slug, config: executorConnectors.config })
          .from(executorConnectors)
          .where(eq(executorConnectors.connectorId, connector.connectorId))
          .limit(1);
        return row ? channelToken(row.projectId, channelPlatform(row.config), row.slug) : null;
      }
      return resolveCredentialValue(connector.connectorId, userId);
    },
    loadEmailSessionContext: async (projectId, sessionId) => {
      const [row] = await db
        .select({ metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, sessionId)))
        .limit(1);
      const email = (row?.metadata as Record<string, any> | undefined)?.email;
      if (!email || typeof email !== 'object') return null;
      const inboxId = typeof email.inbox_id === 'string' ? email.inbox_id : null;
      if (!inboxId) return null;
      return {
        inboxId,
        threadId: typeof email.thread_id === 'string' ? email.thread_id : null,
        messageId: typeof email.message_id === 'string' ? email.message_id : null,
      };
    },
    loadEmailConnectorContext: async (projectId, connectorSlug) => {
      const install = await loadAgentMailInstall(projectId, connectorSlug).catch(() => null);
      return install?.inboxId ? { inboxId: install.inboxId } : null;
    },
    resolveEmailCredentialForInbox: async (projectId, inboxId) =>
      resolveAgentMailApiKey(await loadAgentMailApiKeyForInbox(projectId, inboxId)),
    resolveMeetJoinContext: async (projectId, sessionId) => {
      if (!sessionId) return null;
      const botName = await resolveProjectBotName(projectId);
      const patch = meetRealtimeJoinPatch(projectId, sessionId, deriveWakeWord(botName), botName);
      return patch
        ? {
            metadata: patch.metadata,
            realtimeEndpoints: patch.realtimeEndpoints,
            automaticAudioOutput: patch.automaticAudioOutput,
            botName,
          }
        : null;
    },
    loadPolicies: loadConnectorPoliciesFor,
    loadProjectPolicies: loadProjectPoliciesFor,
    loadDefaultMode: loadDefaultModeFor,
    recordExecution: async (rec) => {
      const [row] = await db
        .insert(executorExecutions)
        .values({
          accountId: rec.accountId,
          projectId: rec.projectId,
          connectorId: rec.connectorId,
          actionPath: rec.actionPath,
          actingUserId: rec.actingUserId,
          sessionId: rec.sessionId,
          status: rec.status,
          risk: rec.risk,
          resultSummary: rec.resultSummary,
          // A pending_approval row is genuinely UNRESOLVED — it's awaiting a human
          // approve/deny (the approvals inbox). Every terminal status (ok/error/
          // denied) resolves at insert. Leaving pending rows unresolved is what lets
          // the inbox query surface exactly the actions still waiting on a decision.
          resolvedAt: rec.status === 'pending_approval' ? null : new Date(),
        })
        .returning({ id: executorExecutions.executionId });
      return row?.id ?? null;
    },
    waitForApprovalDecision: waitForApprovalDecision,
    isSessionToolApproved: isSessionToolApproved,
    consumeApprovedExecution: consumeApprovedExecution,
    markApprovalConsumed: markApprovalConsumed,
    executePipedream: ({ projectId, connectorSlug, app, actionKey, args, accountId, userId }) =>
      runPipedreamAction(projectId, connectorSlug, app, actionKey, args, accountId, userId),
    executePipedreamProxy: ({ projectId, connectorSlug, args, accountId, userId }) =>
      runPipedreamProxy(projectId, connectorSlug, args, accountId, userId),
    // Computer connectors relay through the shared tunnel RPC core (permission
    // check → relay → audit). The machine is resolved from the `computer`
    // selector, scoped to this account.
    executeComputerCall: ({ accountId, selector, method, args }) =>
      executeComputerCall({ accountId, selector, method, args }),
    fetchImpl: nodeFetch,
    enforcePolicies: true,
  };
}

async function loadConnectorPoliciesFor(connectorId: string): Promise<Policy[]> {
  const rows = await db
    .select()
    .from(executorConnectorPolicies)
    .where(eq(executorConnectorPolicies.connectorId, connectorId));
  return rows.map((r) => ({ match: r.match, action: r.action, position: r.position }));
}

async function loadProjectPoliciesFor(projectId: string): Promise<Policy[]> {
  const rows = await db
    .select()
    .from(executorProjectPolicies)
    .where(eq(executorProjectPolicies.projectId, projectId));
  return rows.map((r) => ({ match: r.match, action: r.action, position: r.position }));
}

async function loadDefaultModeFor(projectId: string): Promise<DefaultMode> {
  const [row] = await db
    .select({ defaultMode: executorProjectSettings.defaultMode })
    .from(executorProjectSettings)
    .where(eq(executorProjectSettings.projectId, projectId))
    .limit(1);
  return (row?.defaultMode as DefaultMode) ?? 'allow_all';
}

/** Load a pipedream connector's app slug + id (verifies provider). */
export async function loadPipedreamConnector(projectId: string, slug: string) {
  const [row] = await db
    .select({ connectorId: executorConnectors.connectorId, providerType: executorConnectors.providerType, config: executorConnectors.config })
    .from(executorConnectors)
    .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
    .limit(1);
  if (!row || row.providerType !== 'pipedream') return null;
  const app = (row.config as any)?.app;
  if (typeof app !== 'string' || !app) return null;
  return { connectorId: row.connectorId, app };
}

async function resolvePrincipal(c: Context): Promise<ExecutorPrincipal | null> {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const result = await validateAccountToken(token);
  if (!result.isValid || !result.userId || !result.accountId || !result.projectId) return null;
  return {
    userId: result.userId,
    accountId: result.accountId,
    projectId: result.projectId,
    sessionId: c.req.header('X-Kortix-Session-Id') ?? result.sessionId ?? null,
    subject: await resolveShareSubject(result.userId),
    agentGrant: result.agentGrant ?? null,
  };
}

/**
 * Principal for the project-EXPLICIT gateway routes (/executor/projects/:id/*).
 * These run under combinedAuth, so identity is already validated and sits in the
 * context; the project comes from the PATH. Works for BOTH a project-scoped
 * session token (enforceTokenProjectScope already pinned it to this project) AND
 * a logged-in user token (verified to be a project member here). This is the
 * unlock for using the Executor locally: same gateway, same authz, any principal.
 */
async function resolveProjectPrincipal(c: Context, projectId: string): Promise<ExecutorPrincipal | null> {
  if (!isUuid(projectId)) return null;
  const userId = c.get('userId') as string | undefined;
  if (!userId) return null;
  const tokenProjectId = c.get('tokenProjectId') as string | undefined;
  let accountId = c.get('accountId') as string | undefined;

  if (tokenProjectId) {
    // Project-scoped (session) token: enforceTokenProjectScope already guaranteed
    // tokenProjectId === the URL project at the auth layer. Re-check defensively.
    if (tokenProjectId !== projectId) return null;
  } else {
    // User token (PAT/JWT, no pinned project): verify project access. Throws 403
    // if the user isn't a member — treat that as an unauthorized principal.
    try {
      const access = await loadProjectForUser(c, projectId, 'read');
      if (!access?.row) return null;
      accountId = access.row.accountId; // the PROJECT's account owns its connectors
    } catch (err) {
      if (err instanceof HTTPException && err.status === 403) return null;
      throw err;
    }
  }
  if (!accountId) return null;

  return {
    userId,
    accountId,
    projectId,
    sessionId: c.req.header('X-Kortix-Session-Id') ?? (c.get('sessionId') as string | undefined) ?? null,
    subject: await resolveShareSubject(userId),
    agentGrant: (c.get('agentGrant') as ExecutorPrincipal['agentGrant']) ?? null,
  };
}

/** The catalog a principal can actually use (agent grant + credential present + not blocked). */
async function listCatalog(p: ExecutorPrincipal): Promise<CatalogConnector[]> {
  const conns = hideSupersededSlack(
    await db
      .select()
      .from(executorConnectors)
      .where(and(eq(executorConnectors.projectId, p.projectId), eq(executorConnectors.enabled, true))),
  );

  // Project-scoped layer is the same for every connector in this list — load once.
  const [projectPolicies, defaultMode] = await Promise.all([
    loadProjectPoliciesFor(p.projectId),
    loadDefaultModeFor(p.projectId),
  ]);

  const out: CatalogConnector[] = [];
  for (const row of conns) {
    // Per-agent assignment: an agent only sees connectors its grant lists —
    // consistent with the call gate, so it never lists a tool it can't invoke.
    // This is the ONLY access gate — connectors are project-wide visible to
    // every human with project access (no per-connector member scoping).
    if (!agentMayUseConnector(p.agentGrant ?? null, row.slug)) continue;
    const { hasAuth } = authOf(row);
    if (hasAuth) {
      // Always the shared credential — `per_user` was removed 2026-07-05.
      if (!(await connectorConnected(row, null))) continue;
    }
    const connectorPolicies = await loadConnectorPoliciesFor(row.connectorId);
    const actions = await db.select().from(executorConnectorActions).where(eq(executorConnectorActions.connectorId, row.connectorId));
    out.push({
      slug: row.slug,
      name: row.name,
      provider: row.providerType,
      platform: channelPlatform(row.config),
      status: row.status,
      actions: actions
        .filter((a) => resolveEffectiveAction({
          fullPath: `${row.slug}.${a.path}`,
          relPath: a.path,
          projectPolicies,
          connectorPolicies,
          risk: a.risk,
          defaultMode,
        }).action !== 'block')
        .map((a) => ({ path: a.path, name: a.name, description: a.description ?? '', risk: a.risk, inputSchema: a.inputSchema ?? null })),
    });
  }
  return out;
}

async function resolveAdmin(c: Context, projectId: string): Promise<{ accountId: string; userId: string } | null> {
  if (!isUuid(projectId)) return null;
  const userId = c.get('userId') as string | undefined;
  if (!userId) return null;
  const [proj] = await db.select({ accountId: projects.accountId }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
  if (!proj) return null;
  // Connector administration (create/delete connectors, write shared credentials,
  // grants/policies) is project.connector.write — NOT the coarse, fold-exempt
  // project.write. Thread the acting token (iamTokenId) so the agent-grant fold
  // fires: a scoped agent-session token must actually hold connector.write to
  // manage connectors, and a custom role can withhold it from humans too.
  const actingTokenId = (c.get('iamTokenId') as string | undefined) ?? undefined;
  const decision = await authorize(
    userId,
    proj.accountId,
    'project.connector.write',
    { type: 'project', id: projectId },
    actingTokenId,
  );
  if (!decision.allowed) return null;
  return { accountId: proj.accountId, userId };
}

/** Admin list — sharing + credential mode + whether the shared credential is set.
 *  `viewerUserId` is vestigial (kept for interface stability): it only mattered
 *  for `per_user` connectors, removed 2026-07-05 — every connector now checks
 *  the one shared credential regardless of who's viewing. */
async function listConnectors(projectId: string, viewerUserId: string): Promise<AdminConnectorView[]> {
  let rows = await db.select().from(executorConnectors).where(eq(executorConnectors.projectId, projectId));
  if (rows.length === 0) {
    const [project] = await db
      .select({ accountId: projects.accountId })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (project) {
      await syncProjectConnectors(projectId, project.accountId);
      rows = await db.select().from(executorConnectors).where(eq(executorConnectors.projectId, projectId));
    }
  }
  const conns = hideSupersededSlack(rows);
  const out: AdminConnectorView[] = [];
  for (const row of conns) {
    const { hasAuth } = authOf(row);
    let secretSet = !hasAuth;
    if (hasAuth) {
      secretSet = await connectorConnected(row, null);
    }
    const actions = await db.select().from(executorConnectorActions).where(eq(executorConnectorActions.connectorId, row.connectorId));
    out.push({
      slug: row.slug,
      name: row.name,
      provider: row.providerType,
      platform: channelPlatform(row.config),
      status: row.status,
      credentialMode: 'shared',
      sensitive: (row.config as { sensitive?: unknown } | null)?.sensitive === true,
      actions: actions.map((a) => ({ path: a.path, name: a.name, description: a.description ?? '', risk: a.risk, inputSchema: a.inputSchema ?? null })),
      authSecret: hasAuth ? 'credential' : null,
      secretSet,
    });
  }
  return out;
}

/**
 * Read a connector's per-tool policies for the dashboard/settings surface.
 *
 * Declared connectors are manifest-first (kortix.yaml is their source of truth).
 * Install-driven SYNTHETIC connectors (channel/computer) are never in the
 * manifest, so the manifest read returns null and the route would 404
 * ("connector not found") — even though the connector exists, works, and its
 * policies are enforced at call time from the DB. Fall back to the materialized
 * rows (executor_connector_policies) so the settings panel renders. Only a slug
 * that is neither declared NOR a real DB row returns null (→ a true 404).
 */
async function getConnectorPolicies(
  projectId: string,
  slug: string,
): Promise<{ policies: Array<{ match: string; action: string }> } | null> {
  const fromManifest = await getConnectorPoliciesFromManifest(projectId, slug);
  if (fromManifest) return fromManifest;
  const [row] = await db
    .select({ connectorId: executorConnectors.connectorId })
    .from(executorConnectors)
    .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
    .limit(1);
  if (!row) return null;
  const policies = await loadConnectorPoliciesFor(row.connectorId);
  return { policies: policies.map((p) => ({ match: p.match, action: p.action })) };
}

/**
 * Read a connector's definition for the editor. Same manifest-first / DB-fallback
 * rule as getConnectorPolicies: synthetic channel/computer connectors aren't in
 * kortix.yaml, so reconstruct the view from the materialized row instead of 404ing.
 */
async function getConnectorConfig(
  projectId: string,
  slug: string,
): Promise<Awaited<ReturnType<typeof getConnectorConfigFromManifest>>> {
  const fromManifest = await getConnectorConfigFromManifest(projectId, slug);
  if (fromManifest) return fromManifest;
  const [row] = await db
    .select()
    .from(executorConnectors)
    .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
    .limit(1);
  if (!row) return null;
  const cfg = (row.config ?? {}) as Record<string, any>;
  const { auth } = authOf(row);
  return {
    slug: row.slug,
    provider: row.providerType,
    platform: channelPlatform(row.config) as ChannelPlatform | null,
    credentialMode: 'shared',
    app: cfg.app ?? null,
    account: cfg.account ?? null,
    url: cfg.url ?? null,
    transport: cfg.transport ?? null,
    endpoint: cfg.endpoint ?? null,
    baseUrl: baseUrlOf(row),
    spec: cfg.spec ?? null,
    auth: { type: auth.type, in: auth.in, name: auth.name, prefix: auth.prefix },
  };
}

export const dbExecutorRouterDeps: ExecutorRouterDeps = {
  resolvePrincipal,
  resolveProjectPrincipal,
  makeGatewayDeps: () => makeDbGatewayDeps(),
  listCatalog,
  resolveAdmin,
  listConnectors,
  // The manual "Sync" button re-pulls catalogs unconditionally (force) — the
  // user is explicitly asking to refresh, e.g. an MCP server gained new tools.
  syncConnectors: (projectId, accountId) => syncProjectConnectors(projectId, accountId, { force: true }),
  createConnector: (projectId, accountId, draft) =>
    upsertConnectorInManifest(projectId, accountId, draft as unknown as ConnectorDraft),
  deleteConnector: (projectId, slug) => deleteConnectorFromManifest(projectId, slug),
  setConnectorCredential: (projectId, slug, value) => setConnectorCredentialShared(projectId, slug, value),
  deleteConnectorCredential: async (projectId, slug) => {
    const [row] = await db
      .select()
      .from(executorConnectors)
      .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
      .limit(1);
    if (!row) return { ok: false as const, error: 'connector not found', status: 404 };
    // Always the shared credential — `per_user` was removed 2026-07-05.
    await deleteCredential(row.connectorId, null);
    return { ok: true as const };
  },
  setCredentialMode: (projectId, accountId, slug, mode) => setConnectorCredentialModeInManifest(projectId, accountId, slug, mode),
  setSensitive: (projectId, accountId, slug, sensitive) => setConnectorSensitiveInManifest(projectId, accountId, slug, sensitive),
  setConnectorName: (projectId, accountId, slug, name) => setConnectorNameInManifest(projectId, accountId, slug, name),
  getConnectorPolicies,
  getConnectorConfig,
  setConnectorPolicies: (projectId, accountId, slug, policies) =>
    setConnectorPoliciesInManifest(projectId, accountId, slug, policies as Parameters<typeof setConnectorPoliciesInManifest>[3]),
  // `userId` is accepted for interface stability but unused: every connector
  // resolves the one shared Pipedream external-user binding since `per_user`
  // (each member's own) was removed 2026-07-05.
  pipedreamConnect: pipedreamConfigured()
    ? async (projectId, slug, _userId, redirects) => {
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn) return null;
        const { connectUrl, token } = await pipedreamConnectUrl(projectId, slug, conn.app, null, redirects);
        return { token, app: conn.app, connectUrl };
      }
    : undefined,
  pipedreamFinalize: pipedreamConfigured()
    ? async (projectId, slug, _userId) => {
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn) return null;
        const r = await finalizePipedreamConnection({ projectId, slug, app: conn.app, connectorId: conn.connectorId, userId: null });
        return { connected: r.connected, accountId: r.accountId };
      }
    : undefined,
  pipedreamWebhook: pipedreamConfigured()
    ? async (extUserId, sig) => {
        if (!verifyWebhookSig(extUserId, sig)) return false;
        const [projectId, slug, userId] = extUserId.split(':');
        if (!projectId || !slug) return false;
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn) return false;
        await finalizePipedreamConnection({ projectId, slug, app: conn.app, connectorId: conn.connectorId, userId: userId ?? null });
        return true;
      }
    : undefined,
  listPipedreamApps: pipedreamConfigured()
    ? (query, cursor) => browsePipedreamApps(query, cursor)
    : undefined,
  getProjectPolicies: getProjectPoliciesFromManifest,
  setProjectPolicies: (projectId, accountId, policies, defaultMode) =>
    setProjectPoliciesInManifest(projectId, accountId, policies, defaultMode),
};
