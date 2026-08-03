import {
  executorConnectionProfiles,
  executorConnectorActions,
  executorConnectorPolicies,
  executorConnectors,
  executorExecutions,
  executorProjectPolicies,
  executorProjectSettings,
  projectSessionConnectorBindings,
  projectSessions,
  projects,
  sessionToolApprovals,
} from '@kortix/db';
import { sanitizeConnectorHeaders } from '@kortix/manifest-schema';
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
/**
 * Production wiring for the executor router — DB-backed ExecutorRouterDeps +
 * GatewayDeps. Access lives on the connector; credentials are split per (connector,
 * user). The pure logic (gateway/share/execute/policy/normalize) is tested; this
 * is the glue to Postgres + the credential store + Pipedream. See docs/specs/executor.md.
 */
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolveAgentMailApiKey } from '../channels/agentmail-api';
import {
  loadAgentMailApiKeyForInbox,
  loadAgentMailApiKeyForProject,
  loadAgentMailInstall,
  loadSlackInstall,
  loadSlackTokenForProject,
  loadTeamsBotCredentials,
  loadTeamsInstall,
  loadTeamsTenantForProject,
} from '../channels/install-store';
import { resolveProjectBotName } from '../channels/voice-identity';
import { joinPageUrl } from '../channels/voice/livekit';
import { mintJoinLink } from '../channels/voice/join-links';
import { approvalPageUrl } from '../setup-links/token';
import { endCall, isCallLive, promptVoiceAgent, startCall } from '../channels/voice/runtime';
import { readTranscriptForAgent } from '../channels/voice/transcript-read';
import { kortixSay } from '../channels/voice/utterance';
import { config } from '../config';
import { authorize } from '../iam';
import { agentMayUseConnector } from '../iam/agent-scope';
import type { ChannelPlatform } from '../projects/connectors';
import { invalidateProjectMirror } from '../projects/git';
import { loadProjectForUser } from '../projects/lib/access';
import { connectorAuthorizationMatchesStrategy } from '../projects/lib/connector-authorization-strategy';
import {
  canonicalConnectorAlias,
  publicConnectorAlias,
  resolveProjectDefaultConnectorProfile,
  resolveSessionConnectorProfile,
} from '../projects/lib/session-connector-bindings';
import { validateAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';
import { recordAuditEvent } from '../shared/audit';
import { executeComputerCall } from '../tunnel/core/rpc-core';
import { executorAttachmentStore } from './attachments';
import { hideSupersededSlack } from './channel-rules';
import { buildAdminConnectorViews } from './connector-list';
import {
  connectorIdsWithSharedCredentials,
  credentialExists,
  deleteCredential,
  profileCredentialExists,
  resolveCredentialValue,
  resolveProfileCredentialValue,
} from './credentials';
import type { ExecutorAuth, FetchImpl } from './execute';
import type { GatewayAction, GatewayConnector, GatewayDeps } from './gateway';
import {
  type ConnectorDraft,
  deleteConnectorFromManifest,
  getConnectorConfigFromManifest,
  getConnectorPoliciesFromManifest,
  getProjectPoliciesFromManifest,
  setConnectorCredentialModeInManifest,
  setConnectorAuthorizationStrategyInManifest,
  setConnectorCredentialShared,
  setConnectorNameInManifest,
  setConnectorPoliciesInManifest,
  setConnectorSensitiveInManifest,
  setProjectPoliciesInManifest,
  upsertConnectorInManifest,
} from './manifest-crud';
import { graphToken } from '../channels/teams-auth';
import {
  browsePipedreamApps,
  finalizePipedreamConnection,
  finalizePipedreamProfileConnection,
  pipedreamConfigured,
  pipedreamConnectUrl,
  runPipedreamAction,
  runPipedreamProxy,
  verifyWebhookSig,
} from './pipedream';
import {
  type DefaultMode,
  type EffectiveResolveResult,
  type Policy,
  type PolicyAction,
  parseStoredConditions,
  resolveEffectiveAction,
} from './policy';
import type {
  AdminConnectorView,
  CatalogConnector,
  ExecutorPrincipal,
  ExecutorRouterDeps,
} from './router';
import { resolveShareSubject } from './share';
import { getIntegrationCatalogDetail, listIntegrationCatalog } from './integration-catalog';
import { discoverDraftConnectorAuth, syncProjectConnectors } from './sync';
import type { ActionBinding, Risk } from './types';
import { executionAuditEvent } from './execution-audit';

/** Which policy scope decided an action — surfaced so the editor can say so. */
type EffectiveSource = EffectiveResolveResult['source'];

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
  expect?: { sessionId: string | null; connectorId: string; actionPath: string },
): Promise<'approved' | 'denied' | 'timeout' | 'mismatch'> {
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 1000;
  // Bind the approval row to the (session, connector, action) actually being
  // authorized. A client supplies approvalExecutionId in the request body; without
  // this binding it could point at ANY resolved execution row to auto-approve an
  // unrelated sensitive call (confused-deputy replay of the require_approval gate).
  const conds = [eq(executorExecutions.executionId, executionId)];
  if (expect) {
    if (expect.sessionId) conds.push(eq(executorExecutions.sessionId, expect.sessionId));
    conds.push(eq(executorExecutions.connectorId, expect.connectorId));
    conds.push(eq(executorExecutions.actionPath, expect.actionPath));
  }
  while (Date.now() < deadline) {
    const [row] = await db
      .select({
        status: executorExecutions.status,
        resolvedAt: executorExecutions.resolvedAt,
        approvedBy: executorExecutions.approvedBy,
        resultSummary: executorExecutions.resultSummary,
      })
      .from(executorExecutions)
      .where(and(...conds))
      .limit(1);
    // No row under the expected binding → the supplied id belongs to a different
    // session/connector/action (or doesn't exist). Never wait on it.
    if (!row) return 'mismatch';
    if (row.resolvedAt) {
      if (row.status === 'denied') return 'denied';
      // Only a GENUINE, still-UNCONSUMED human approve authorizes the call —
      // mirror consumeApprovedExecution's guard exactly. A resolved row that is
      // NOT that (a plain ok/error run row, which never has approvedBy, or an
      // already-consumed approval being REPLAYED, which has consumed_at stamped)
      // must never resolve to 'approved' — treating any resolved non-denied row
      // as approved is the require_approval bypass (replay a resolved execution
      // id to auto-authorize a sensitive call). The legit FIRST waiter still
      // passes: the gateway stamps consumed_at only AFTER this returns 'approved'
      // (gateway.ts markApprovalConsumed), so consumed_at is still null in-band;
      // only LATER replays see it set and are rejected here.
      const rs: Record<string, unknown> = row.resultSummary ?? {};
      if (row.approvedBy != null && rs.decision === 'approve' && rs.consumed_at == null) {
        return 'approved';
      }
      // Resolved but not a genuine, unconsumed approve. Don't authorize: the
      // bound row can't flip to genuine, so keep polling until it hits 'timeout'
      // (the gateway then leaves the call paused, exactly as if never approved).
    }
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
    ? {
        type: cfg.auth.type,
        in: cfg.auth.in ?? 'header',
        name: cfg.auth.name ?? null,
        prefix: cfg.auth.prefix ?? null,
      }
    : DEFAULT_AUTH;
  const hasAuth = row.providerType === 'pipedream' || auth.type !== 'none';
  return { auth, hasAuth };
}

/**
 * The connector's static request headers (kortix.yaml `headers:`, persisted
 * into `config` by the materializer). Sanitized on the way out — a row written
 * before the header rules existed can never inject an illegal header.
 */
function headersOf(row: ConnectorRow): Record<string, string> {
  const cfg = (row.config ?? {}) as Record<string, any>;
  return sanitizeConnectorHeaders(cfg.headers);
}

function baseUrlOf(row: ConnectorRow): string | null {
  const cfg = (row.config ?? {}) as Record<string, any>;
  switch (row.providerType) {
    case 'openapi':
      return cfg.server ?? null;
    case 'http':
      return cfg.baseUrl ?? null;
    case 'graphql':
      return cfg.endpoint ?? null;
    case 'mcp':
      return cfg.url ?? null;
    case 'channel':
      return cfg.baseUrl ?? null;
    // computer: no base URL — the gateway relays via the tunnel core, not HTTP.
    case 'computer':
      return null;
    default:
      return null;
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

async function channelToken(
  projectId: string,
  platform: string | null,
  slug?: string | null,
): Promise<string | null> {
  if (platform === 'slack') return loadSlackTokenForProject(projectId);
  if (platform === 'teams') {
    const tenant = await loadTeamsTenantForProject(projectId);
    if (!tenant) return null;
    const creds = await loadTeamsBotCredentials(projectId);
    return graphToken(tenant, creds).catch(() => null);
  }
  if (platform === 'email')
    return resolveAgentMailApiKey(await loadAgentMailApiKeyForProject(projectId, slug));
  return null;
}

/** Cheap "is it connected?" — the install exists (no decrypt). */
async function channelInstalled(
  projectId: string,
  platform: string | null,
  slug?: string | null,
): Promise<boolean> {
  if (platform === 'slack') return (await loadSlackInstall(projectId).catch(() => null)) != null;
  if (platform === 'teams') return (await loadTeamsInstall(projectId).catch(() => null)) != null;
  if (platform === 'email')
    return (await loadAgentMailInstall(projectId, slug).catch(() => null)) != null;
  return false;
}

/**
 * Whether a connector's credential is present for `userId` — channel connectors
 * check their platform install; everyone else checks executor_credentials. One
 * place so the catalog + admin listings don't each re-branch on provider.
 */
async function connectorConnected(
  row: ConnectorRow,
  userId: string | null,
  profile?: {
    profileId: string;
    isDefault: boolean;
    metadata: Record<string, unknown>;
  } | null,
): Promise<boolean> {
  if (row.providerType === 'channel') {
    const profileSlug =
      typeof profile?.metadata.connector_slug === 'string'
        ? profile.metadata.connector_slug
        : row.slug;
    if (!(await channelInstalled(row.projectId, channelPlatform(row.config), profileSlug))) {
      return false;
    }
    if (channelPlatform(row.config) === 'email' && typeof profile?.metadata.inbox_id === 'string') {
      const install = await loadAgentMailInstall(row.projectId, profileSlug).catch(() => null);
      return install?.inboxId === profile.metadata.inbox_id;
    }
    return true;
  }
  return profile
    ? (await profileCredentialExists({
        connectorId: row.connectorId,
        profileId: profile.profileId,
      })) ||
        (profile.isDefault && (await credentialExists(row.connectorId, userId)))
    : credentialExists(row.connectorId, userId);
}

function toGatewayConnector(
  row: ConnectorRow,
  profile?: {
    profileId: string;
    isDefault: boolean;
    metadata: Record<string, unknown>;
  } | null,
): GatewayConnector {
  const { auth, hasAuth } = authOf(row);
  return {
    connectorId: row.connectorId,
    profileId: profile?.profileId ?? null,
    profileIsDefault: profile?.isDefault ?? false,
    profileMetadata: profile?.metadata ?? {},
    slug: row.slug,
    provider: row.providerType,
    platform: channelPlatform(row.config),
    baseUrl: baseUrlOf(row),
    auth,
    headers: headersOf(row),
    hasAuth,
    // `per_user` was removed 2026-07-05; every row is `shared` (DB-enforced by
    // a CHECK constraint), so this is a defensive cast, not a live branch.
    credentialMode: 'shared',
    enabled: row.enabled,
    sensitive: (row.config as { sensitive?: unknown } | null)?.sensitive === true,
  };
}

const nodeFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    ...(init.tls ? { tls: init.tls } : {}),
  } as RequestInit);
  return { status: res.status, ok: res.ok, text: () => res.text() };
};

export function makeDbGatewayDeps(principal: ExecutorPrincipal): GatewayDeps {
  return {
    attachmentStore: executorAttachmentStore,
    loadConnectorBySlug: async (projectId, slug) => {
      const [row] = await db
        .select()
        .from(executorConnectors)
        .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
        .limit(1);
      if (!row) return null;
      const profile = await resolveSessionConnectorProfile({
        accountId: principal.accountId,
        projectId,
        sessionId: principal.sessionId,
        alias: slug,
        actingUserId: principal.userId,
      });
      if (!profile || profile.status !== 'active') return null;
      return toGatewayConnector(row, profile);
    },
    loadAction: async (connectorId, relPath) => {
      const [a] = await db
        .select()
        .from(executorConnectorActions)
        .where(
          and(
            eq(executorConnectorActions.connectorId, connectorId),
            eq(executorConnectorActions.path, relPath),
          ),
        )
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
          .select({
            projectId: executorConnectors.projectId,
            slug: executorConnectors.slug,
            config: executorConnectors.config,
          })
          .from(executorConnectors)
          .where(eq(executorConnectors.connectorId, connector.connectorId))
          .limit(1);
        const profileSlug =
          typeof connector.profileMetadata?.connector_slug === 'string'
            ? connector.profileMetadata.connector_slug
            : row?.slug;
        return row ? channelToken(row.projectId, channelPlatform(row.config), profileSlug) : null;
      }
      if (connector.profileId) {
        const credential = await resolveProfileCredentialValue({
          connectorId: connector.connectorId,
          profileId: connector.profileId,
        });
        if (credential !== null) return credential;
        if (!connector.profileIsDefault) return null;
      }
      return connector.profileIsDefault || !connector.profileId
        ? resolveCredentialValue(connector.connectorId, userId)
        : null;
    },
    // Session metadata is user-writable, so it is not a trusted routing source
    // for inbox, thread, or message identifiers. A future channel-owned binding
    // may provide this context; until then callers must pass explicit action args.
    loadEmailSessionContext: async () => null,
    loadEmailConnectorContext: async (projectId, connectorSlug) => {
      const install = await loadAgentMailInstall(projectId, connectorSlug).catch(() => null);
      return install?.inboxId ? { inboxId: install.inboxId } : null;
    },
    resolveEmailCredentialForInbox: async (projectId, inboxId) =>
      resolveAgentMailApiKey(await loadAgentMailApiKeyForInbox(projectId, inboxId)),
    loadPolicies: loadConnectorPoliciesFor,
    loadProjectPolicies: loadProjectPoliciesFor,
    loadDefaultMode: loadDefaultModeFor,
    mintApprovalLink: ({ projectId, executionId, sessionId }) =>
      approvalPageUrl(projectId, executionId, sessionId, config.FRONTEND_URL),
    recordExecution: async (rec) => {
      const [row] = await db
        .insert(executorExecutions)
        .values({
          accountId: rec.accountId,
          projectId: rec.projectId,
          connectorId: rec.connectorId,
          profileId: rec.profileId,
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
      if (!row?.id) return null;
      try {
        await recordAuditEvent(executionAuditEvent(rec, row.id));
      } catch (error) {
        console.error('[executor] Failed to record central audit event:', error);
      }
      return row.id;
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
    executeComputerCall: ({
      accountId,
      projectId,
      sessionId,
      actorUserId,
      selector,
      method,
      args,
    }) =>
      executeComputerCall({
        accountId,
        projectId,
        sessionId,
        actorUserId,
        selector,
        method,
        args,
      }),
    // Voice channel: `spawn_room` creates the LiveKit room + human join token
    // (the same logic voice/routes.ts used to inline before it went through
    // the gateway); `join_gmeet`/`join_zoom` are declared but not implemented
    // yet, so they fail loud with what to do instead rather than pretending.
    executeVoiceCall: async ({ projectId, sessionId, op, args }) => {
      if (op === 'join_gmeet' || op === 'join_zoom') {
        const platform = op === 'join_gmeet' ? 'Google Meet' : 'Zoom';
        return {
          ok: false,
          kind: 'not_implemented',
          message: `joining an existing ${platform} is not supported yet — use spawn_room and share the join link instead`,
        };
      }
      // The call id IS the session id, so every action below addresses "this
      // session's call" without the agent having to carry a call id around.
      if (op === 'read_transcript') {
        if (!sessionId) {
          return { ok: false, kind: 'error', message: 'read_transcript requires a session' };
        }
        // Mode resolution, the per-call read position, the page shape and the
        // unread count all live in channels/voice/transcript-read.ts — read its
        // header for why a bare call is the cheap one, and for what happens to
        // "unread" turns when a turn dies mid-read. Everything except liveness,
        // which is a LiveKit question, not a transcript one.
        const read = await readTranscriptForAgent({ callId: sessionId, projectId, args });
        return { ok: true, data: { ...read, live: await isCallLive(sessionId) } };
      }

      if (op === 'send_prompt') {
        if (!sessionId) {
          return { ok: false, kind: 'error', message: 'send_prompt requires a session' };
        }
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) {
          return { ok: false, kind: 'error', message: 'send_prompt requires `text`' };
        }
        // `kortixSay` carries both halves of this utterance: the framing the
        // voice model needs (it is handed the text as INSTRUCTIONS, so raw text
        // reads as an unattributed order — that is what made the call answer
        // statements as questions) AND the plain line that gets written to
        // voice_call_turns, so what this agent says into the call is actually in
        // the call's record. `projectId` is passed because we have it here; the
        // in-call paths (turn.ts, answer-watch.ts) look it up instead.
        const result = await promptVoiceAgent(sessionId, kortixSay(text), { projectId });
        if (!result.delivered) {
          // Deliberately an error, not a silent success: an agent that believes
          // it spoke and did not will carry on as though the room heard it.
          return { ok: false, kind: 'error', message: result.reason ?? 'could not reach the call' };
        }
        return { ok: true, data: { spoken: true } };
      }

      if (op === 'end_call') {
        if (!sessionId) {
          return { ok: false, kind: 'error', message: 'end_call requires a session' };
        }
        await endCall(sessionId);
        return { ok: true, data: { ended: true } };
      }

      if (op !== 'spawn_room') {
        return { ok: false, kind: 'error', message: `unknown voice action "${op}"` };
      }
      if (!sessionId) {
        return { ok: false, kind: 'error', message: 'spawn_room requires a session' };
      }
      const voice = typeof args.voice === 'string' ? args.voice : null;
      const botName = await resolveProjectBotName(projectId);
      // The call id IS the session id — one live call per session.
      const callId = sessionId;
      // Start the room BEFORE minting the human's join link. If a person opens
      // the page first it would try to join a room that does not exist yet,
      // and that join is rejected with nothing to retry against.
      await startCall({ callId, projectId, sessionId, botName, voice });
      // Hand out a short, ungessable link that resolves to a freshly-minted
      // LiveKit access token server-side (public-join-routes.ts), rather than
      // embedding the ~300-char signed JWT itself in the URL — see
      // join-links.ts's header for why (a single corrupted character in
      // transit used to break the signature with no way to retry).
      const { token: joinToken } = await mintJoinLink({ callId, projectId });
      const joinUrl = joinPageUrl(config.FRONTEND_URL, joinToken);
      return { ok: true, data: { call_id: callId, join_url: joinUrl } };
    },
    fetchImpl: nodeFetch,
    enforcePolicies: true,
  };
}

async function loadConnectorPoliciesFor(connectorId: string): Promise<Policy[]> {
  const rows = await db
    .select()
    .from(executorConnectorPolicies)
    .where(eq(executorConnectorPolicies.connectorId, connectorId));
  return rows.map((r) => ({
    match: r.match,
    action: r.action,
    position: r.position,
    // Conditions are re-validated on READ, never trusted from storage.
    ...parseStoredConditions(r.conditions),
  }));
}

async function loadProjectPoliciesFor(projectId: string): Promise<Policy[]> {
  const rows = await db
    .select()
    .from(executorProjectPolicies)
    .where(eq(executorProjectPolicies.projectId, projectId));
  return rows.map((r) => ({
    match: r.match,
    action: r.action,
    position: r.position,
    ...parseStoredConditions(r.conditions),
  }));
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
    .select({
      connectorId: executorConnectors.connectorId,
      providerType: executorConnectors.providerType,
      config: executorConnectors.config,
      authorizationStrategy: executorConnectors.authorizationStrategy,
    })
    .from(executorConnectors)
    .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
    .limit(1);
  if (!row || row.providerType !== 'pipedream') return null;
  const app = (row.config as any)?.app;
  if (typeof app !== 'string' || !app) return null;
  return {
    connectorId: row.connectorId,
    app,
    authorizationStrategy: row.authorizationStrategy,
  };
}

export type ConnectLinkEligibility =
  | { ok: true; connectorId: string; app: string; authorizationStrategy: string }
  /** No connector with this slug on the project. The manifest really is missing it. */
  | { ok: false; reason: 'no_such_connector' }
  /** It exists, but a setup link is a Pipedream Quick Connect and this is not one. */
  | { ok: false; reason: 'not_pipedream'; providerType: string }
  /** Pipedream-backed but its config names no app — a broken connector, not a missing one. */
  | { ok: false; reason: 'no_app' };

/**
 * Why a connect link can or cannot be minted for this slug.
 *
 * `loadPipedreamConnector` answers all three failures with `null`, so the mint
 * route told everyone to "add it to kortix.yaml first" — including the people
 * whose connector is already in kortix.yaml and simply is not Pipedream-backed.
 * That sends someone to edit a file that already has the entry they are being
 * asked to add, and the connector they actually need is reachable by a route
 * this one cannot offer.
 */
export async function connectLinkEligibility(
  projectId: string,
  slug: string,
): Promise<ConnectLinkEligibility> {
  const [row] = await db
    .select({
      connectorId: executorConnectors.connectorId,
      providerType: executorConnectors.providerType,
      config: executorConnectors.config,
      authorizationStrategy: executorConnectors.authorizationStrategy,
    })
    .from(executorConnectors)
    .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
    .limit(1);
  if (!row) return { ok: false, reason: 'no_such_connector' };
  if (row.providerType !== 'pipedream') {
    return { ok: false, reason: 'not_pipedream', providerType: row.providerType };
  }
  const app = (row.config as any)?.app;
  if (typeof app !== 'string' || !app) return { ok: false, reason: 'no_app' };
  return {
    ok: true,
    connectorId: row.connectorId,
    app,
    authorizationStrategy: row.authorizationStrategy,
  };
}

export function resolveTokenBoundSessionId(
  authenticatedSessionId: string | null,
  requestedSessionId: string | null,
): { ok: true; sessionId: string | null } | { ok: false } {
  if (requestedSessionId && requestedSessionId !== authenticatedSessionId) {
    return { ok: false };
  }
  return { ok: true, sessionId: authenticatedSessionId };
}

/**
 * Only project-scoped tokens carry a Kortix project session identity.
 * Supabase JWTs also set `sessionId`, but that value identifies the Supabase
 * authentication session. It must not enter connector profile resolution.
 */
export function projectSessionIdForProjectPrincipal(
  tokenProjectId: string | undefined,
  contextualSessionId: string | undefined,
): string | null {
  return tokenProjectId ? (contextualSessionId ?? null) : null;
}

async function resolvePrincipal(c: Context): Promise<ExecutorPrincipal | null> {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const result = await validateAccountToken(token);
  if (!result.isValid || !result.userId || !result.accountId || !result.projectId) return null;
  const sessionIdentity = resolveTokenBoundSessionId(
    result.sessionId ?? null,
    c.req.header('X-Kortix-Session-Id') ?? null,
  );
  if (!sessionIdentity.ok) return null;
  return {
    userId: result.userId,
    accountId: result.accountId,
    projectId: result.projectId,
    sessionId: sessionIdentity.sessionId,
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
async function resolveProjectPrincipal(
  c: Context,
  projectId: string,
): Promise<ExecutorPrincipal | null> {
  if (!isUuid(projectId)) return null;
  const userId = c.get('userId') as string | undefined;
  if (!userId) return null;
  const tokenProjectId = c.get('tokenProjectId') as string | undefined;
  let accountId = c.get('accountId') as string | undefined;

  if (tokenProjectId) {
    // Project-scoped (session) token: enforceTokenProjectScope already guaranteed
    // tokenProjectId === the URL project at the auth layer. Re-check defensively,
    // then bind the token account to the actual project account. This prevents a
    // PAT row from one account from being labeled with another account's project
    // id and then used on the project-explicit Executor gateway.
    if (tokenProjectId !== projectId) return null;
    const [project] = await db
      .select({ accountId: projects.accountId })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!project || !accountId || project.accountId !== accountId) return null;
    accountId = project.accountId;
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
  const sessionIdentity = resolveTokenBoundSessionId(
    projectSessionIdForProjectPrincipal(
      tokenProjectId,
      c.get('sessionId') as string | undefined,
    ),
    c.req.header('X-Kortix-Session-Id') ?? null,
  );
  if (!sessionIdentity.ok) return null;

  return {
    userId,
    accountId,
    projectId,
    sessionId: sessionIdentity.sessionId,
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
      .where(
        and(eq(executorConnectors.projectId, p.projectId), eq(executorConnectors.enabled, true)),
      ),
  );

  // Project-scoped layer is the same for every connector in this list — load once.
  const [projectPolicies, defaultMode] = await Promise.all([
    loadProjectPoliciesFor(p.projectId),
    loadDefaultModeFor(p.projectId),
  ]);

  // SAFETY NET — the durable binding aliases this session has explicitly bound.
  // A session created before the create-path `inherit_unbound` default fix
  // (absent → `false`) with `connector_bindings` set would have
  // `connector_bindings_configured = true, inherit_unbound = false`, and
  // `resolveSessionConnectorProfile` returns null for EVERY unbound alias,
  // emptying the catalog. For those, we fall back to the PROJECT DEFAULT
  // profile — but ONLY for aliases with NO durable binding row. A present
  // binding that resolves to null because it is revoked/error/strategy-
  // mismatched still fails closed (the security invariant: a present but
  // revoked/error binding never falls through to a project default). Loading
  // the bound-alias set once here keeps the per-connector fallback a cheap
  // set lookup rather than an extra query per connector.
  const boundAliases: Set<string> | null = p.sessionId
    ? await loadSessionBoundAliases(p.accountId, p.projectId, p.sessionId)
    : null;

  const out: CatalogConnector[] = [];
  for (const row of conns) {
    // Per-agent assignment: an agent only sees connectors its grant lists —
    // consistent with the call gate, so it never lists a tool it can't invoke.
    // This is the ONLY access gate — connectors are project-wide visible to
    // every human with project access (no per-connector member scoping).
    // Canonical on both sides — the grant is canonicalized at construction.
    if (!agentMayUseConnector(p.agentGrant ?? null, canonicalConnectorAlias(row.slug))) continue;
    let profile = await resolveSessionConnectorProfile({
      accountId: p.accountId,
      projectId: p.projectId,
      sessionId: p.sessionId,
      alias: row.slug,
      actingUserId: p.userId,
    });
    // Safety net: a pre-fix session (configured + not-inherit-unbound) hides
    // unbound aliases. For an alias with NO durable binding, fall back to the
    // project default so the catalog isn't empty. An alias WITH a binding that
    // resolved null stays null (revoked/error fails closed).
    if ((!profile || profile.status !== 'active') && boundAliases !== null) {
      const alias = canonicalConnectorAlias(row.slug);
      if (!boundAliases.has(alias)) {
        const fallback = await resolveProjectDefaultConnectorProfile({
          accountId: p.accountId,
          projectId: p.projectId,
          alias: row.slug,
          actingUserId: p.userId,
        });
        if (fallback && fallback.status === 'active') profile = fallback;
      }
    }
    if (!profile || profile.status !== 'active') continue;
    const { hasAuth } = authOf(row);
    if (hasAuth) {
      // Always the shared credential — `per_user` was removed 2026-07-05.
      if (!(await connectorConnected(row, null, profile))) continue;
    }
    const connectorPolicies = await loadConnectorPoliciesFor(row.connectorId);
    const actions = await db
      .select()
      .from(executorConnectorActions)
      .where(eq(executorConnectorActions.connectorId, row.connectorId));
    out.push({
      slug: row.slug,
      name: row.name,
      provider: row.providerType,
      platform: channelPlatform(row.config),
      status: row.status,
      actions: actions
        .filter(
          (a) =>
            resolveEffectiveAction({
              fullPath: `${row.slug}.${a.path}`,
              relPath: a.path,
              projectPolicies,
              connectorPolicies,
              risk: a.risk,
              defaultMode,
            }).action !== 'block',
        )
        .map((a) => ({
          path: a.path,
          name: a.name,
          description: a.description ?? '',
          risk: a.risk,
          inputSchema: a.inputSchema ?? null,
        })),
    });
  }
  return out;
}

/**
 * The canonical aliases a session has explicitly bound (durable
 * `project_session_connector_bindings` rows). Used by `listCatalog`'s safety
 * net to distinguish "no binding → fall back to project default" from
 * "present-but-null binding → fail closed". Returns null only when there is
 * no session in scope.
 */
async function loadSessionBoundAliases(
  accountId: string,
  projectId: string,
  sessionId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ alias: projectSessionConnectorBindings.connectorAlias })
    .from(projectSessionConnectorBindings)
    .where(
      and(
        eq(projectSessionConnectorBindings.sessionId, sessionId),
        eq(projectSessionConnectorBindings.accountId, accountId),
        eq(projectSessionConnectorBindings.projectId, projectId),
      ),
    );
  return new Set(rows.map((r) => canonicalConnectorAlias(r.alias)));
}

async function resolveProjectUserWith(
  c: Context,
  projectId: string,
  action: 'project.connector.read' | 'project.connector.write',
): Promise<{ accountId: string; userId: string } | null> {
  if (!isUuid(projectId)) return null;
  const userId = c.get('userId') as string | undefined;
  if (!userId) return null;
  const [proj] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!proj) return null;
  // Thread the acting token (iamTokenId) so the agent-grant fold fires: a
  // scoped agent-session token must actually hold the leaf, and a custom role
  // can withhold it from humans too.
  const actingTokenId = (c.get('iamTokenId') as string | undefined) ?? undefined;
  const decision = await authorize(
    userId,
    proj.accountId,
    action,
    { type: 'project', id: projectId },
    actingTokenId,
  );
  if (!decision.allowed) return null;
  return { accountId: proj.accountId, userId };
}

// Connector administration (create/delete connectors, write shared credentials,
// grants/policies) is project.connector.write — NOT the coarse, fold-exempt
// project.write.
async function resolveAdmin(
  c: Context,
  projectId: string,
): Promise<{ accountId: string; userId: string } | null> {
  return resolveProjectUserWith(c, projectId, 'project.connector.write');
}

// The connectors LIST is read-tier: project.connector.read is in the member
// baseline (the Connectors/Channels rail sections gate visibility on it), so a
// plain member can see which connectors exist and their status. The list never
// carries credential values — only whether one is set.
async function resolveReader(
  c: Context,
  projectId: string,
): Promise<{ accountId: string; userId: string } | null> {
  return resolveProjectUserWith(c, projectId, 'project.connector.read');
}

/** Admin list — sharing + credential mode + whether the shared credential is set. */
async function listConnectors(projectId: string): Promise<AdminConnectorView[]> {
  const conns = hideSupersededSlack(
    await db.select().from(executorConnectors).where(eq(executorConnectors.projectId, projectId)),
  );
  if (conns.length === 0) return [];

  const credentialRows = conns.filter((row) => {
    const { hasAuth } = authOf(row);
    return hasAuth && row.providerType !== 'channel';
  });
  const channelRows = conns.filter((row) => {
    const { hasAuth } = authOf(row);
    return hasAuth && row.providerType === 'channel';
  });
  const [actions, credentialConnectorIds, connectedChannelSlugs] = await Promise.all([
    db
      .select()
      .from(executorConnectorActions)
      .where(
        inArray(
          executorConnectorActions.connectorId,
          conns.map((row) => row.connectorId),
        ),
      ),
    connectorIdsWithSharedCredentials(credentialRows.map((row) => row.connectorId)),
    Promise.all(
      channelRows.map(async (row) => [row.slug, await connectorConnected(row, null)] as const),
    ).then(
      (entries) => new Set(entries.filter(([, connected]) => connected).map(([slug]) => slug)),
    ),
  ]);
  const actionsByConnector = new Map<string, typeof actions>();
  for (const action of actions) {
    const current = actionsByConnector.get(action.connectorId) ?? [];
    current.push(action);
    actionsByConnector.set(action.connectorId, current);
  }

  const connectedSlugs = new Set(connectedChannelSlugs);
  for (const row of credentialRows) {
    if (credentialConnectorIds.has(row.connectorId)) connectedSlugs.add(row.slug);
  }
  const candidates = conns.map((row) => {
    const { auth, hasAuth } = authOf(row);
    const config = row.config as { icon_url?: unknown; sensitive?: unknown } | null;
    return {
      slug: row.slug,
      name: row.name,
      provider: row.providerType,
      platform: channelPlatform(row.config),
      iconUrl: typeof config?.icon_url === 'string' ? config.icon_url : null,
      status: row.status,
      authorizationStrategy: row.authorizationStrategy,
      sensitive: config?.sensitive === true,
      actions: (actionsByConnector.get(row.connectorId) ?? []).map((a) => ({
        path: a.path,
        name: a.name,
        description: a.description ?? '',
        risk: a.risk,
        inputSchema: a.inputSchema ?? null,
      })),
      requestAuthType: auth.type,
      requiresAuth: hasAuth,
    };
  });
  return buildAdminConnectorViews(candidates, connectedSlugs);
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
): Promise<{
  policies: Array<{ match: string; action: string }>;
  effective: Array<{ path: string; action: PolicyAction; source: EffectiveSource }>;
  project_policies: Array<{ match: string; action: string }>;
  default_mode: DefaultMode;
} | null> {
  const [fromManifest, [row]] = await Promise.all([
    getConnectorPoliciesFromManifest(projectId, slug),
    db
      .select({ connectorId: executorConnectors.connectorId, config: executorConnectors.config })
      .from(executorConnectors)
      .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
      .limit(1),
  ]);
  if (!fromManifest && !row) return null;

  const policies = fromManifest
    ? fromManifest.policies
    : (await loadConnectorPoliciesFor(row.connectorId)).map((p) => ({
        match: p.match,
        action: p.action as string,
      }));

  // The editor also needs to know WHICH scope decides each tool. A project-scope
  // rule is evaluated first and cannot be overridden here (see policy.ts), so
  // without this the panel would happily show a connector rule the runtime is
  // ignoring. Resolve every action through the same function the call gate uses.
  if (!row) {
    return { policies, effective: [], project_policies: [], default_mode: 'allow_all' };
  }
  const [projectPolicies, defaultMode, actions] = await Promise.all([
    loadProjectPoliciesFor(projectId),
    loadDefaultModeFor(projectId),
    db
      .select()
      .from(executorConnectorActions)
      .where(eq(executorConnectorActions.connectorId, row.connectorId)),
  ]);
  const sensitive = (row.config as { sensitive?: unknown } | null)?.sensitive === true;
  const connectorPolicies: Policy[] = policies.map((p) => ({
    match: p.match,
    action: p.action as PolicyAction,
  }));
  const effective = actions.map((a) => {
    const resolved = resolveEffectiveAction({
      fullPath: `${slug}.${a.path}`,
      relPath: a.path,
      projectPolicies,
      connectorPolicies,
      risk: a.risk,
      defaultMode,
      sensitive,
    });
    return { path: a.path, action: resolved.action, source: resolved.source };
  });
  return {
    policies,
    effective,
    project_policies: projectPolicies.map((p) => ({ match: p.match, action: p.action })),
    default_mode: defaultMode,
  };
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
    name: row.name,
    provider: row.providerType,
    platform: channelPlatform(row.config) as ChannelPlatform | null,
    credentialMode: 'shared',
    authorizationStrategy: row.authorizationStrategy,
    app: cfg.app ?? null,
    account: cfg.account ?? null,
    url: cfg.url ?? null,
    transport: cfg.transport ?? null,
    endpoint: cfg.endpoint ?? null,
    baseUrl: baseUrlOf(row),
    spec: cfg.spec ?? null,
    auth: { type: auth.type, in: auth.in, name: auth.name, prefix: auth.prefix },
    headers: headersOf(row),
  };
}

export const dbExecutorRouterDeps: ExecutorRouterDeps = {
  attachmentStore: executorAttachmentStore,
  resolvePrincipal,
  resolveProjectPrincipal,
  makeGatewayDeps: (principal) => makeDbGatewayDeps(principal),
  listCatalog,
  resolveAdmin,
  resolveReader,
  listConnectors,
  // The manual "Sync" button re-pulls catalogs unconditionally (force) — the
  // user is explicitly asking to refresh, e.g. an MCP server gained new tools.
  syncConnectors: (projectId, accountId) => {
    invalidateProjectMirror(projectId);
    return syncProjectConnectors(projectId, accountId, { force: true });
  },
  createConnector: (projectId, accountId, draft) =>
    upsertConnectorInManifest(projectId, accountId, draft as unknown as ConnectorDraft),
  deleteConnector: (projectId, slug) => deleteConnectorFromManifest(projectId, slug),
  setConnectorCredential: (projectId, slug, input) =>
    setConnectorCredentialShared(projectId, slug, input),
  deleteConnectorCredential: async (projectId, slug) => {
    const [row] = await db
      .select({
        connectorId: executorConnectors.connectorId,
        authorizationStrategy: executorConnectors.authorizationStrategy,
      })
      .from(executorConnectors)
      .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
      .limit(1);
    if (!row) return { ok: false as const, error: 'connector not found', status: 404 };
    if (row.authorizationStrategy !== 'project') {
      return {
        ok: false as const,
        error: 'Shared credentials require a project authorization strategy',
        status: 409,
      };
    }
    await deleteCredential(row.connectorId, null);
    return { ok: true as const };
  },
  setCredentialMode: (projectId, accountId, slug, mode) =>
    setConnectorCredentialModeInManifest(projectId, accountId, slug, mode),
  setAuthorizationStrategy: (projectId, accountId, slug, authorizationStrategy) =>
    setConnectorAuthorizationStrategyInManifest(
      projectId,
      accountId,
      slug,
      authorizationStrategy,
    ),
  setSensitive: (projectId, accountId, slug, sensitive) =>
    setConnectorSensitiveInManifest(projectId, accountId, slug, sensitive),
  setConnectorName: (projectId, accountId, slug, name) =>
    setConnectorNameInManifest(projectId, accountId, slug, name),
  getConnectorPolicies,
  getConnectorConfig,
  setConnectorPolicies: (projectId, accountId, slug, policies) =>
    setConnectorPoliciesInManifest(
      projectId,
      accountId,
      slug,
      policies as Parameters<typeof setConnectorPoliciesInManifest>[3],
    ),
  pipedreamConnect: pipedreamConfigured()
    ? async (projectId, slug, _userId, redirects) => {
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn || conn.authorizationStrategy !== 'project') return null;
        const { connectUrl, token } = await pipedreamConnectUrl(
          projectId,
          slug,
          conn.app,
          null,
          redirects,
        );
        return { token, app: conn.app, connectUrl };
      }
    : undefined,
  pipedreamFinalize: pipedreamConfigured()
    ? async (projectId, slug, _userId) => {
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn || conn.authorizationStrategy !== 'project') return null;
        const r = await finalizePipedreamConnection({
          projectId,
          slug,
          app: conn.app,
          connectorId: conn.connectorId,
          userId: null,
        });
        return { connected: r.connected, accountId: r.accountId };
      }
    : undefined,
  pipedreamWebhook: pipedreamConfigured()
    ? async (extUserId, sig) => {
        if (!verifyWebhookSig(extUserId, sig)) return false;
        const [projectId, slug, identityId] = extUserId.split(':');
        if (!projectId || !slug) return false;
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn) return false;
        if (identityId) {
          const [profile] = await db
            .select({
              profileId: executorConnectionProfiles.profileId,
              ownerType: executorConnectionProfiles.ownerType,
              ownerId: executorConnectionProfiles.ownerId,
            })
            .from(executorConnectionProfiles)
            .where(
              and(
                eq(executorConnectionProfiles.profileId, identityId),
                eq(executorConnectionProfiles.projectId, projectId),
                eq(executorConnectionProfiles.connectorId, conn.connectorId),
              ),
            )
            .limit(1);
          if (
            profile &&
            connectorAuthorizationMatchesStrategy({
              strategy: conn.authorizationStrategy,
              ownerType: profile.ownerType,
              ownerId: profile.ownerId,
              actingUserId: profile.ownerId ?? '',
              actingPrincipalIsServiceAccount: false,
            })
          ) {
            await finalizePipedreamProfileConnection({
              projectId,
              slug,
              app: conn.app,
              connectorId: conn.connectorId,
              profileId: profile.profileId,
              createdBy: null,
            });
            return true;
          }
          return false;
        }
        if (conn.authorizationStrategy !== 'project') return false;
        await finalizePipedreamConnection({
          projectId,
          slug,
          app: conn.app,
          connectorId: conn.connectorId,
          userId: null,
        });
        return true;
      }
    : undefined,
  listPipedreamApps: pipedreamConfigured()
    ? (query, cursor) => browsePipedreamApps(query, cursor)
    : undefined,
  discoverConnectorAuth: discoverDraftConnectorAuth,
  listDiscoverIntegrations: (input) => listIntegrationCatalog(input),
  getDiscoverIntegration: (id) => getIntegrationCatalogDetail(id),
  getProjectPolicies: getProjectPoliciesFromManifest,
  setProjectPolicies: (projectId, accountId, policies, defaultMode) =>
    setProjectPoliciesInManifest(projectId, accountId, policies, defaultMode),
};
