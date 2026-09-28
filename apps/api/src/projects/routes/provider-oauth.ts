/** LLM provider OAuth device flow (ChatGPT subscription via Codex): start, poll, status, disconnect. */
import { parseSharingIntent } from '../../connectors/share';
import { randomUUID } from 'node:crypto';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { recordAuditEvent, runAuditedTransaction } from '../../shared/audit';
import { db } from '../../shared/db';
import { roleAllows } from '../access';
import { pollCodexDeviceAuth, startCodexDeviceAuth } from '../codex-device-auth';
import { requestPersonalOwner } from '../lib/personal-resources';
import {
  decryptProjectSecret,
  encryptProjectSecret,
  resolveProjectSecretForConsumer,
} from '../secrets';
import { propagateProjectSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';
import { isGatewayManagedEnv } from '../../llm-gateway/sandbox-credentials';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { createRoute, z } from '@hono/zod-openapi';
import { accountMembers, accountSecretGrants, accountSecretResources } from '@kortix/db';
import { encryptAccountSecret, memberMayReadProject } from '../../secrets/account-resource';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { projectSecrets } from '@kortix/db';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  loadProjectForUser,
  assertProjectCapability,
} from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import {
  CODEX_AUTH_JSON_SECRET_NAME,
  loadSecretViewsForUser,
  normalizeString,
} from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';

// ─── Provider OAuth device flow (poll-based) ───────────────────────────────
//
// Connect a subscription-backed LLM provider (today: a ChatGPT Plus/Pro
// account via the OpenAI Codex device grant) and save the resulting login as
// the project's CODEX_AUTH_JSON secret. Only the LLM gateway can decrypt this
// value. The sandbox receives neither the token nor an opaque handle.
//
// Two quick, NON-streaming calls so they survive any edge (a long-lived
// streaming response gets reset by Cloudflare) and any replica:
//   POST …/oauth/:provider/start → kicks the device flow in a DETACHED
//        background task on this replica, returns the device challenge.
//   POST …/oauth/:provider/poll  → ANY replica reads the shared DB flow row;
//        once the user finishes authorizing, writes the secret and returns it.
// The in-flight flow lives in `kortix.oauth_provider_flows` (not replica
// memory), so start and poll need not hit the same pod. The detached task
// isn't tied to a client connection, so nothing the edge does can kill it.

// Kortix provider id → the secret we persist the resulting auth.json under.
// Only OpenAI (ChatGPT) is wired today; the shape generalizes to others.
// `legacySecretNames` are older names for the same login. Nothing writes them
// any more, but clients and the gateway still count them as connected, so a
// disconnect must delete them too.
const OAUTH_PROVIDERS: Record<string, { secretName: string; legacySecretNames?: string[] }> = {
  openai: { secretName: CODEX_AUTH_JSON_SECRET_NAME, legacySecretNames: ['OPENCODE_AUTH_JSON'] },
};

// How long the encrypted flow handle stays valid (OpenAI expires the device
// code on its side too; this just bounds the opaque handle clients hold).
const DEVICE_AUTH_TTL_MS = 15 * 60 * 1000;
// Floor for the client poll cadence (OpenAI returns its own suggested interval).
const OAUTH_POLL_INTERVAL_MS = 3000;

// Persists the Codex auth.json as the CODEX_AUTH_JSON project secret — private
// (the caller's own per-user OAuth login, ownerUserId-scoped) when `sharing`
// says so, else the project-wide shared row — then returns the caller's view
// of it. Codex-specific on purpose: a generic OPENCODE_AUTH_JSON row is never
// overwritten by this. `sharing` only ever chooses private-vs-shared here —
// member/group secret sharing was retired (see projects/secrets.ts).
async function writeCodexAuthSecret(input: {
  projectId: string;
  accountId: string;
  userId: string;
  value: string;
  sharing?: ReturnType<typeof parseSharingIntent>;
}) {
  const { projectId, accountId, userId, value, sharing } = input;
  const now = new Date();
  let secretId: string;

  if (sharing?.mode === 'private') {
    const [written] = await db
      .insert(projectSecrets)
      .values({
        projectId,
        identifier: CODEX_AUTH_JSON_SECRET_NAME,
        name: CODEX_AUTH_JSON_SECRET_NAME,
        valueEnc: encryptProjectSecret(projectId, value),
        ownerUserId: userId,
        active: true,
        strategy: 'broker',
        consumer: 'llm_gateway',
        strategyLocked: true,
        rotatedAt: now,
        createdBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectSecrets.projectId, projectSecrets.name, projectSecrets.ownerUserId],
        targetWhere: sql`${projectSecrets.ownerUserId} is not null`,
        set: {
          valueEnc: encryptProjectSecret(projectId, value),
          active: true,
          strategy: 'broker',
          consumer: 'llm_gateway',
          egressPolicy: null,
          handlePrefix: null,
          strategyLocked: true,
          rotatedAt: now,
          updatedAt: now,
        },
      })
      .returning({ secretId: projectSecrets.secretId });
    if (!written) throw new Error('Failed to store the private Codex credential');
    secretId = written.secretId;
  } else {
    const [written] = await db
      .insert(projectSecrets)
      .values({
        projectId,
        identifier: CODEX_AUTH_JSON_SECRET_NAME,
        name: CODEX_AUTH_JSON_SECRET_NAME,
        valueEnc: encryptProjectSecret(projectId, value),
        strategy: 'broker',
        consumer: 'llm_gateway',
        strategyLocked: true,
        rotatedAt: now,
        createdBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectSecrets.projectId, projectSecrets.identifier],
        targetWhere: isNull(projectSecrets.ownerUserId),
        set: {
          valueEnc: encryptProjectSecret(projectId, value),
          strategy: 'broker',
          consumer: 'llm_gateway',
          egressPolicy: null,
          handlePrefix: null,
          strategyLocked: true,
          rotatedAt: now,
          updatedAt: now,
        },
      })
      .returning({ secretId: projectSecrets.secretId });
    if (!written) throw new Error('Failed to store the shared Codex credential');
    secretId = written.secretId;
  }

  await recordAuditEvent({
    accountId,
    projectId,
    actorUserId: userId,
    actorType: 'human',
    source: 'api',
    action: 'secret.oauth.connected',
    resourceType: 'project_secret',
    resourceId: secretId,
    metadata: {
      identifier: CODEX_AUTH_JSON_SECRET_NAME,
      consumer: 'llm_gateway',
      sharing: sharing?.mode === 'private' ? 'private' : 'project',
    },
  });

  void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: true });

  const views = await loadSecretViewsForUser({
    projectId,
    userId,
    canManageShared: true,
  });
  return views.find((v) => v.identifier === CODEX_AUTH_JSON_SECRET_NAME)
    ?? { identifier: CODEX_AUTH_JSON_SECRET_NAME, name: CODEX_AUTH_JSON_SECRET_NAME };
}

/** A named connection only its owner can use: private, or restricted to the owner
 * alone. Anything wider shares a credential, which is a project secret write. */
function sharingIsOwnerOnly(sharing: ReturnType<typeof parseSharingIntent> | undefined, ownerId: string): boolean {
  if (sharing?.mode === 'private') return true;
  return sharing?.mode === 'members' && !sharing.groupIds?.length &&
    (sharing.memberIds ?? []).every((memberId) => memberId === ownerId);
}

/** Reconnect writes a fresh login into the caller's own ChatGPT account resource.
 * Its id, label, access, and session selections stay. A deleted account, or one
 * the caller did not create, matches no row, so a stale flow never recreates it. */
async function reconnectCodexAccountResource(input: {
  secretId: string; accountId: string; userId: string; projectId: string; value: string;
}): Promise<{ secretId: string; label: string } | null> {
  const { secretId, accountId, userId, projectId, value } = input;
  const [row] = await db.update(accountSecretResources).set({
    valueEnc: encryptAccountSecret(accountId, value),
    active: true,
    cooldownUntil: null,
    updatedAt: new Date(),
  }).where(and(
    eq(accountSecretResources.accountId, accountId),
    eq(accountSecretResources.secretId, secretId),
    eq(accountSecretResources.projectId, projectId),
    eq(accountSecretResources.providerId, 'codex'),
    eq(accountSecretResources.name, CODEX_AUTH_JSON_SECRET_NAME),
    eq(accountSecretResources.createdBy, userId),
  )).returning({ secretId: accountSecretResources.secretId, label: accountSecretResources.label });
  if (!row) return null;
  await recordAuditEvent({
    accountId, projectId, actorUserId: userId, actorType: 'human', source: 'api',
    action: 'secret.oauth.connected', resourceType: 'account_secret_resource', resourceId: row.secretId,
    metadata: { provider_id: 'codex', consumer: 'llm_gateway', reconnected: true },
  });
  return row;
}

/** One OAuth completion creates one project-scoped account resource. The flow's UUID
 * makes concurrent or repeated polls idempotent without replacing another login. */
async function writeCodexAccountResource(input: {
  secretId: string; accountId: string; userId: string; label: string; value: string; projectId: string;
  sharing?: ReturnType<typeof parseSharingIntent>;
}) {
  const { secretId, accountId, userId, label, value, projectId, sharing } = input;
  const restricted = sharing?.mode === 'members' || sharing?.mode === 'private';
  const userIds = [...new Set([userId, ...(sharing?.mode === 'members' ? sharing.memberIds ?? [] : [])])];
  const created = await db.transaction(async (tx) => {
    const [row] = await tx.insert(accountSecretResources).values({
      secretId, accountId, projectId, accessMode: restricted ? 'members' : 'project', label, providerId: 'codex', name: CODEX_AUTH_JSON_SECRET_NAME,
      valueEnc: encryptAccountSecret(accountId, value), consumer: 'llm_gateway',
      strategy: 'broker', createdBy: userId,
    }).onConflictDoNothing().returning({ secretId: accountSecretResources.secretId });
    if (row) await tx.insert(accountSecretGrants).values(userIds.map((grantee) => ({ accountId, secretId, userId: grantee, grantedBy: userId })));
    return Boolean(row);
  });
  if (created) await recordAuditEvent({
    accountId, projectId, actorUserId: userId, actorType: 'human', source: 'api',
    action: 'secret.oauth.connected', resourceType: 'account_secret_resource', resourceId: secretId,
    metadata: { provider_id: 'codex', consumer: 'llm_gateway' },
  });
  return secretId;
}

// Best-effort token expiry (ms remaining) from a stored auth.json, for display.
function authExpiresInMs(authJson: string): number | null {
  try {
    const parsed = JSON.parse(authJson);
    // opencode auth.json is keyed by provider: { openai: { expires, ... } }.
    for (const entry of Object.values(parsed ?? {})) {
      const expires = (entry as { expires?: unknown })?.expires;
      if (typeof expires === 'number' && Number.isFinite(expires)) {
        return Math.max(0, expires - Date.now());
      }
    }
  } catch {
    // not parseable / no expiry — treat as unknown
  }
  return null;
}

// ─── POST /v1/projects/:projectId/oauth/:provider/start ────────────────────
// Kick the device flow in a detached background task; return the challenge.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/oauth/{provider}/start',
    tags: ['secrets'],
    summary: 'POST /:projectId/oauth/:provider/start',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), provider: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'Device challenge'),
        ...errors(400, 401, 403, 404, 502),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const body = await readJsonObject(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  if (!OAUTH_PROVIDERS[provider]) {
    return c.json({ error: `OAuth device flow is not available for "${provider}"` }, 400);
  }

  const resourceLabel = body.resource_label === undefined ? null :
    typeof body.resource_label === 'string' ? body.resource_label.trim() : '';
  if (resourceLabel !== null && (resourceLabel.length < 1 || resourceLabel.length > 100)) {
    return c.json({ error: 'A named OAuth resource requires a 1–100 character label' }, 400);
  }
  // Reconnect refreshes the login of an existing ChatGPT account resource in
  // place. It never renames or re-shares it, so a label or sharing is refused.
  const resourceId = body.resource_id === undefined ? null :
    typeof body.resource_id === 'string' ? body.resource_id.trim() : '';
  if (resourceId !== null && !z.string().uuid().safeParse(resourceId).success) {
    return c.json({ error: 'resource_id must be the id of a ChatGPT account' }, 400);
  }
  if (resourceId !== null && (resourceLabel !== null || body.sharing != null)) {
    return c.json({ error: 'Reconnecting keeps the account label and access; send only resource_id' }, 400);
  }
  const named = resourceLabel !== null || resourceId !== null;
  if (named && (!resolveFeatureFlag(loaded.row.metadata, 'pooled_provider_secrets') ||
    !projectLlmGatewayEnabled(loaded.row.metadata))) {
    return c.json({ error: 'Pooled OAuth connections require pooled provider secrets and the LLM gateway' }, 403);
  }
  if (named) {
    const [member] = await db.select({ userId: accountMembers.userId }).from(accountMembers)
      .where(and(eq(accountMembers.accountId, loaded.row.accountId), eq(accountMembers.userId, loaded.userId))).limit(1);
    if (!member) return c.json({ error: 'An account member must own a ChatGPT connection' }, 403);
  }
  if (resourceId !== null) {
    const [resource] = await db.select({
      projectId: accountSecretResources.projectId,
      providerId: accountSecretResources.providerId,
      name: accountSecretResources.name,
      createdBy: accountSecretResources.createdBy,
    }).from(accountSecretResources)
      .where(and(eq(accountSecretResources.accountId, loaded.row.accountId), eq(accountSecretResources.secretId, resourceId)))
      .limit(1);
    if (!resource || resource.projectId !== projectId || resource.providerId !== 'codex' ||
      resource.name !== CODEX_AUTH_JSON_SECRET_NAME) {
      return c.json({ error: 'ChatGPT account not found' }, 404);
    }
    // The login is the owner's own subscription; only they re-authorize it.
    // Account admins can still delete the account.
    if (resource.createdBy !== loaded.userId) {
      return c.json({ error: 'Only the person who connected this ChatGPT account can reconnect it' }, 403);
    }
  }

  let sharing: ReturnType<typeof parseSharingIntent> | undefined;
  if (body.sharing != null) {
    sharing = parseSharingIntent(body.sharing, loaded.userId);
    if (!sharing) {
      return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);
    }
    if (resourceLabel !== null) {
      if (sharing.mode === 'private' && sharing.ownerId !== loaded.userId) return c.json({ error: 'Invalid connection owner' }, 400);
      if (sharing.mode === 'members') {
        if (sharing.groupIds?.length || (sharing.memberIds?.length ?? 0) > 200) return c.json({ error: 'Select up to 200 project members' }, 400);
        for (const userId of sharing.memberIds ?? []) {
          if (!z.string().uuid().safeParse(userId).success || !(await memberMayReadProject(loaded.row.accountId, projectId, userId))) {
            return c.json({ error: 'Member has no project access' }, 400);
          }
        }
      }
    }
  }
  // A shared credential is a project SECRET WRITE (the device flow persists it
  // via writeCodexAuthSecret on poll). Gate on the leaf so a custom role can
  // withhold it and the agent-grant fold applies — closing the gap where the
  // flow wrote a shared credential behind only loadProjectForUser('read'). A
  // private (owner-only) credential is the member's own, so read still suffices.
  // A named account restricted to its owner alone is owner-only too, however
  // the client spells it; so is reconnecting your own account. The legacy
  // unnamed login treats `members` as shared, so this applies to named ones only.
  // The poll step is reachable only with the project-key-encrypted flow handle
  // minted here, so gating start transitively protects the write on poll.
  const ownerOnly = resourceId !== null ||
    (resourceLabel !== null && sharingIsOwnerOnly(sharing, loaded.userId));
  if (sharing?.mode !== 'private' && !ownerOnly) {
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);
  }

  // Request a device code straight from OpenAI — a couple HTTPS calls, no
  // subprocess, no server-side flow record. Everything `poll` needs is sealed
  // into the opaque `flow_id` (encrypted with the project key), so any replica
  // can serve any poll and there's nothing to leak or OOM.
  let challenge;
  try {
    challenge = await startCodexDeviceAuth();
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to start ChatGPT authorization',
    }, 502);
  }

  const expiresAt = Date.now() + DEVICE_AUTH_TTL_MS;
  const flowId = encryptProjectSecret(
    projectId,
    JSON.stringify({
      d: challenge.deviceAuthId,
      u: challenge.userCode,
      s: sharing ?? null,
      uid: loaded.userId,
      ...(resourceLabel === null ? {} : { l: resourceLabel, rid: randomUUID() }),
      ...(resourceId === null ? {} : { rid: resourceId, rc: 1 }),
      e: expiresAt,
    }),
  );

  return c.json({
    flow_id: flowId,
    verification_url: challenge.verificationUrl,
    user_code: challenge.userCode,
    expires_at: expiresAt,
    interval_ms: Math.max(challenge.intervalMs, OAUTH_POLL_INTERVAL_MS),
  });
},
);

// ─── POST /v1/projects/:projectId/oauth/:provider/poll ─────────────────────
// Any replica: read the shared flow row; on success persist the secret.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/oauth/{provider}/poll',
    tags: ['secrets'],
    summary: 'POST /:projectId/oauth/:provider/poll',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), provider: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'Poll result'),
        ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const body = await readJsonObject(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const flowId = normalizeString(body.flow_id);
  if (!flowId) return c.json({ error: 'flow_id is required' }, 400);

  // Decrypt the opaque flow handle. The key is project-scoped, so a handle from
  // another project — or a tampered one — simply won't decrypt → expired.
  let state: { d?: string; u?: string; s?: unknown; uid?: string; e?: number; l?: string; rid?: string; rc?: number };
  try {
    state = JSON.parse(decryptProjectSecret(projectId, flowId));
  } catch {
    return c.json({ status: 'expired' });
  }
  // Only the member who started it may poll it, and only before it expires.
  if (
    !state.d || !state.u ||
    state.uid !== loaded.userId ||
    typeof state.e !== 'number' || Date.now() > state.e
  ) {
    return c.json({ status: 'expired' });
  }
  if ((state.l || state.rc) && state.rid) {
    const [member] = await db.select({ userId: accountMembers.userId }).from(accountMembers)
      .where(and(eq(accountMembers.accountId, loaded.row.accountId), eq(accountMembers.userId, loaded.userId))).limit(1);
    if (!member) return c.json({ status: 'failed', error: 'Account membership is required' });
  }

  const result = await pollCodexDeviceAuth({ deviceAuthId: state.d, userCode: state.u });
  if (result.status === 'pending') {
    return c.json({ status: 'pending', next_poll_ms: OAUTH_POLL_INTERVAL_MS });
  }
  if (result.status === 'failed') {
    return c.json({ status: 'failed', error: result.error });
  }

  if (state.rc && state.rid) {
    if (!resolveFeatureFlag(loaded.row.metadata, 'pooled_provider_secrets') ||
      !projectLlmGatewayEnabled(loaded.row.metadata)) {
      return c.json({ status: 'failed', error: 'Pooled OAuth connections are disabled for this project' });
    }
    const reconnected = await reconnectCodexAccountResource({
      secretId: state.rid, accountId: loaded.row.accountId, userId: loaded.userId,
      projectId, value: result.authJson,
    });
    if (!reconnected) {
      return c.json({ status: 'failed', error: 'This ChatGPT account is no longer available. Add it again.' });
    }
    return c.json({ status: 'success', credential: {
      provider_id: 'codex', secret_id: reconnected.secretId, label: reconnected.label,
      expires_in_ms: authExpiresInMs(result.authJson), updated_at: new Date().toISOString(),
    } });
  }

  // The sealed resource id makes a completed device flow idempotent. A new
  // device flow gets a new resource; it never overwrites another user's login.
  if (state.l && state.rid) {
    if (!resolveFeatureFlag(loaded.row.metadata, 'pooled_provider_secrets') ||
      !projectLlmGatewayEnabled(loaded.row.metadata)) {
      return c.json({ status: 'failed', error: 'Pooled OAuth connections are disabled for this project' });
    }
    const secretId = await writeCodexAccountResource({
      secretId: state.rid, accountId: loaded.row.accountId, userId: loaded.userId,
      label: state.l, value: result.authJson, projectId,
      sharing: state.s ? (parseSharingIntent(state.s, loaded.userId) ?? undefined) : undefined,
    });
    return c.json({ status: 'success', credential: {
      provider_id: 'codex', secret_id: secretId, label: state.l,
      expires_in_ms: authExpiresInMs(result.authJson), updated_at: new Date().toISOString(),
    } });
  }

  // Legacy project login remains available when no resource label was sent.
  const sharing = state.s ? (parseSharingIntent(state.s, loaded.userId) ?? undefined) : undefined;
  await writeCodexAuthSecret({
    projectId,
    accountId: loaded.row.accountId,
    userId: loaded.userId,
    value: result.authJson,
    sharing,
  });

  return c.json({
    status: 'success',
    credential: {
      provider_id: provider,
      expires_in_ms: authExpiresInMs(result.authJson),
      updated_at: new Date().toISOString(),
    },
  });
},
);

// ─── GET /v1/projects/:projectId/oauth ─────────────────────────────────────
// List configured OAuth credentials (derived from the saved project secrets).
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/oauth',
    tags: ['secrets'],
    summary: 'GET /:projectId/oauth',
    ...auth,
      request: { params: z.object({ projectId: z.string() }) },
    responses: {
        200: json(z.any(), 'Configured OAuth credentials'),
        ...errors(401, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);

  const items: Array<{ provider_id: string; expires_in_ms: number | null; updated_at: string }> = [];
  for (const [providerId, cfg] of Object.entries(OAUTH_PROVIDERS)) {
    const credential = await resolveProjectSecretForConsumer({
      projectId,
      accountId: loaded.row.accountId,
      actorUserId: loaded.userId,
      principalUserId: await requestPersonalOwner(c, loaded),
      name: cfg.secretName,
      consumer: 'llm_gateway',
    });
    if (!credential) continue;
    items.push({
      provider_id: providerId,
      expires_in_ms: authExpiresInMs(credential.value),
      updated_at: credential.updatedAt.toISOString(),
    });
  }

  return c.json({ items });
},
);

// ─── DELETE /v1/projects/:projectId/oauth/:provider ────────────────────────
// Remove an OAuth credential (deletes the backing secret).
// The login can be a per-user PRIVATE row (`owner_user_id` set) or the shared
// project row. The delete covers exactly the rows `loadSecretViewsForUser`
// shows the caller: the caller's own private rows, plus the shared row when
// the caller may manage shared secrets. Another member's private login is
// never touched.
projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/oauth/{provider}',
    tags: ['secrets'],
    summary: 'DELETE /:projectId/oauth/:provider',
    ...auth,
      request: { params: z.object({ projectId: z.string(), provider: z.string() }) },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);

  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg) return c.json({ error: 'Not found' }, 404);

  // Same test the GET secrets route uses for `can_manage_shared`.
  const canManageShared = roleAllows(loaded.effectiveRole, 'manage');
  const ownPrivate = eq(projectSecrets.ownerUserId, loaded.userId);

  await runAuditedTransaction(
    async (tx) => {
      await tx
        .delete(projectSecrets)
        .where(
          and(
            eq(projectSecrets.projectId, projectId),
            inArray(projectSecrets.name, [cfg.secretName, ...(cfg.legacySecretNames ?? [])]),
            canManageShared ? or(ownPrivate, isNull(projectSecrets.ownerUserId)) : ownPrivate,
          ),
        );
    },
    () => ({
      accountId: loaded.row.accountId,
      projectId,
      actorUserId: loaded.userId,
      actorType: 'human',
      source: 'api',
      action: 'secret.oauth.disconnected',
      resourceType: 'project_secret',
      metadata: {
        identifier: cfg.secretName,
        consumer: 'llm_gateway',
        scope: canManageShared ? 'own_private_and_shared' : 'own_private',
      },
    }),
  );
  void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: isGatewayManagedEnv(cfg.secretName) });

  return c.json({ ok: true });
},
);
