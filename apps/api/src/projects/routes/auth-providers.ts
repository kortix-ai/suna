/**
 * Registry-driven auth routes — docs/specs/2026-07-22-unified-auth-gateway.md
 * Step 3 (§6.3, §8.3). The single surface the web two-door picker and the CLI
 * read for "how do I connect provider X, and is my stored connection healthy":
 *
 *   GET    /:projectId/auth-providers                       — both doors, +status, +BYOK tail
 *   GET    /:projectId/auth-providers/:providerId/status    — one credential's typed status
 *   POST   /:projectId/oauth-credentials/:providerId/start  — device-code start (opaque handle)
 *   POST   /:projectId/oauth-credentials/:providerId/poll   — device-code poll → persist on success
 *   GET    /:projectId/oauth-credentials                    — list connected account-door credentials
 *   DELETE /:projectId/oauth-credentials/:providerId        — disconnect (delete backing secret)
 *
 * These GENERALIZE `r3.ts`'s Codex-only `/oauth/:provider/*` routes: the same
 * opaque-encrypted-handle pattern (`auth/oauth/flow-state.ts`), the same
 * shared/personal secret write (`auth/oauth/credential-store.ts`), driven by
 * the provider-generic `DeviceFlowAdapter` (`auth/oauth/device-flow.ts`)
 * instead of the hardcoded `OAUTH_PROVIDERS = { openai }` stub. The old
 * `/oauth/*` routes stay mounted unchanged as a compatibility alias (spec Step
 * 6 retires them later) — both now share one credential-store implementation,
 * so there is no behavioral drift.
 *
 * The response deliberately NEVER leaks the server-only `OAuthClientConfig`
 * (client id / authorize+token URLs / scopes) — the browser never drives OAuth
 * itself (spec §6.1), so it never needs them.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { type HarnessId, compatibleHarnessesFor } from '@kortix/shared/harnesses';

import { parseSharingIntent } from '../../executor/share';
import { PROJECT_ACTIONS } from '../../iam';
import {
  invalidateCredentialStatus,
  resolveCredentialStatusCached,
} from '../../llm-gateway/auth/credential-status';
import {
  deleteOAuthCredentialSecret,
  writeOAuthCredentialSecret,
} from '../../llm-gateway/auth/oauth/credential-store';
import {
  type DeviceFlowStartResult,
  deviceFlowAdapter,
} from '../../llm-gateway/auth/oauth/device-flow';
import { openFlowState, sealFlowState } from '../../llm-gateway/auth/oauth/flow-state';
import {
  AUTH_PROVIDERS,
  type AuthDoor,
  type AuthFlow,
  deriveCatalogByokEntries,
  findAuthProvider,
} from '../../llm-gateway/auth/registry';
import {
  type CredentialRecord,
  UnknownAuthProviderError,
} from '../../llm-gateway/auth/resolve-credential-status';
import { auth, errors, json } from '../../openapi';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { normalizeString, readBody } from '../lib/serializers';

// How long the encrypted flow handle stays valid (the provider expires the
// device code on its side too; this just bounds the opaque handle clients hold).
const DEVICE_AUTH_TTL_MS = 15 * 60 * 1000;
// Floor for the client poll cadence (the provider returns its own suggested interval).
const OAUTH_POLL_INTERVAL_MS = 3000;

export interface AuthProviderView {
  id: string;
  label: string;
  door: AuthDoor;
  producesAuthKind: string;
  compatibleHarnesses: HarnessId[];
  flows: { web: AuthFlow[] };
  /** `true` when a flow is present but flag-gated OFF (Anthropic one-click, spec §11#1). */
  gated: boolean;
  refresh: 'refresh-token' | 'none';
}

/**
 * The non-status projection of every registry provider (both doors), pure and
 * DB-free so `auth-providers.test.ts` can assert the two-door shape without a
 * database. The route layers live `status` on top.
 */
export function authProviderBaseViews(): AuthProviderView[] {
  return AUTH_PROVIDERS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    door: entry.door,
    producesAuthKind: entry.producesAuthKind,
    compatibleHarnesses: compatibleHarnessesFor(entry.producesAuthKind),
    flows: { web: entry.flows.web },
    gated: Boolean(entry.gatedBehind),
    refresh: entry.refresh,
  }));
}

async function statusForView(
  view: AuthProviderView,
  projectId: string,
  userId: string | null,
): Promise<CredentialRecord | null> {
  try {
    return await resolveCredentialStatusCached(projectId, userId, view.id, view.door);
  } catch {
    // Never let one provider's probe failure sink the whole listing.
    return null;
  }
}

// ─── GET /v1/projects/:projectId/auth-providers ────────────────────────────
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/auth-providers',
    tags: ['projects'],
    summary: 'List connectable auth providers (both doors) with live credential status',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'Auth providers'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
    );

    const providers = await Promise.all(
      authProviderBaseViews().map(async (view) => ({
        ...view,
        status: await statusForView(view, projectId, loaded.userId),
      })),
    );

    return c.json({ providers, byok: deriveCatalogByokEntries() });
  },
);

// ─── GET /v1/projects/:projectId/auth-providers/:providerId/status ─────────
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/auth-providers/{providerId}/status',
    tags: ['projects'],
    summary: 'Typed credential status for one auth provider',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), providerId: z.string() }),
      query: z.object({ door: z.enum(['account', 'api-key']).optional() }),
    },
    responses: { 200: json(z.any(), 'Credential status'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const providerId = c.req.param('providerId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
    );

    const doorParam = c.req.query('door') as AuthDoor | undefined;
    // Disambiguate: Anthropic/OpenAI each have an account AND an api-key row.
    const entry = doorParam
      ? findAuthProvider(providerId, doorParam)
      : (findAuthProvider(providerId, 'account') ?? findAuthProvider(providerId, 'api-key'));
    if (!entry) return c.json({ error: `Unknown auth provider "${providerId}"` }, 404);

    try {
      const status = await resolveCredentialStatusCached(
        projectId,
        loaded.userId,
        entry.id,
        entry.door,
      );
      return c.json({ status });
    } catch (err) {
      if (err instanceof UnknownAuthProviderError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  },
);

interface SealedDeviceFlow {
  d: string;
  u: string;
  s: unknown;
  uid: string;
  e: number;
  p: string;
}

// ─── POST /v1/projects/:projectId/oauth-credentials/:providerId/start ──────
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/oauth-credentials/{providerId}/start',
    tags: ['projects'],
    summary: 'Start an account-door connect flow (device-code)',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), providerId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: { 200: json(z.any(), 'Device challenge'), ...errors(400, 401, 403, 404, 502) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const providerId = c.req.param('providerId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const entry = findAuthProvider(providerId, 'account');
    if (!entry) {
      return c.json({ error: `"${providerId}" is not a connectable account provider` }, 404);
    }
    // The Anthropic one-click browser-OAuth shell ships wired-but-OFF (spec
    // §11#1) — never reachable here. Its sanctioned web path is `paste-token`
    // (below), not a start call.
    const adapter = entry.gatedBehind ? undefined : deviceFlowAdapter(providerId);
    if (!adapter) {
      // paste-token providers (Anthropic) and gated ones have no device flow —
      // the client POSTs the token to /secrets directly (spec §6.3/§6.6(2)).
      return c.json(
        {
          error: `"${entry.label}" does not use a device-code flow`,
          flow: entry.flows.web[0] ?? null,
        },
        400,
      );
    }

    let sharing: ReturnType<typeof parseSharingIntent> | undefined;
    if (body.sharing != null) {
      sharing = parseSharingIntent(body.sharing, loaded.userId);
      if (!sharing) {
        return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);
      }
    }
    // A shared credential is a project SECRET WRITE (persisted on poll). Gate on
    // the leaf so a custom role can withhold it. A private (owner-only)
    // credential is the member's own, so read still suffices. Poll is reachable
    // only with the project-key-encrypted handle minted here, so gating start
    // transitively protects the write on poll (mirrors r3's rationale).
    if (sharing?.mode !== 'private') {
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
      );
    }

    let challenge: DeviceFlowStartResult;
    try {
      challenge = await adapter.start();
    } catch (err) {
      return c.json(
        {
          error:
            err instanceof Error ? err.message : `Failed to start ${entry.label} authorization`,
        },
        502,
      );
    }

    const expiresAt = Date.now() + DEVICE_AUTH_TTL_MS;
    const flowId = sealFlowState<SealedDeviceFlow>(projectId, {
      d: challenge.deviceAuthId,
      u: challenge.userCode,
      s: sharing ?? null,
      uid: loaded.userId,
      e: expiresAt,
      p: providerId,
    });

    return c.json({
      flow_id: flowId,
      verification_url: challenge.verificationUrl,
      user_code: challenge.userCode,
      expires_at: expiresAt,
      interval_ms: Math.max(challenge.intervalMs, OAUTH_POLL_INTERVAL_MS),
    });
  },
);

// ─── POST /v1/projects/:projectId/oauth-credentials/:providerId/poll ───────
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/oauth-credentials/{providerId}/poll',
    tags: ['projects'],
    summary: 'Poll an account-door connect flow; persist the credential on success',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), providerId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: { 200: json(z.any(), 'Poll result'), ...errors(400, 401, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const providerId = c.req.param('providerId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const entry = findAuthProvider(providerId, 'account');
    const adapter = entry && !entry.gatedBehind ? deviceFlowAdapter(providerId) : undefined;
    if (!entry || !adapter) return c.json({ error: 'Not found' }, 404);

    const flowId = normalizeString(body.flow_id);
    if (!flowId) return c.json({ error: 'flow_id is required' }, 400);

    const state = openFlowState<SealedDeviceFlow>(projectId, flowId);
    // Only the member who started it may poll it, only before it expires, and
    // only against the provider it was minted for.
    if (
      !state ||
      !state.d ||
      !state.u ||
      state.uid !== loaded.userId ||
      state.p !== providerId ||
      typeof state.e !== 'number' ||
      Date.now() > state.e
    ) {
      return c.json({ status: 'expired' });
    }

    const result = await adapter.poll({ deviceAuthId: state.d, userCode: state.u });
    if (result.status === 'pending') {
      return c.json({ status: 'pending', next_poll_ms: OAUTH_POLL_INTERVAL_MS });
    }
    if (result.status === 'failed') {
      return c.json({ status: 'failed', error: result.error });
    }

    const sharing = state.s ? (parseSharingIntent(state.s, loaded.userId) ?? undefined) : undefined;
    await writeOAuthCredentialSecret({
      projectId,
      userId: loaded.userId,
      secretName: adapter.secretName,
      value: result.authJson,
      sharing,
    });
    invalidateCredentialStatus(projectId, loaded.userId, entry.id, entry.door);

    return c.json({
      status: 'success',
      credential: {
        provider_id: providerId,
        expires_in_ms: adapter.expiresInMs(result.authJson),
        updated_at: new Date().toISOString(),
      },
    });
  },
);

// ─── GET /v1/projects/:projectId/oauth-credentials ─────────────────────────
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/oauth-credentials',
    tags: ['projects'],
    summary: 'List connected account-door credentials with typed status',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'Connected credentials'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
    );

    const accountEntries = AUTH_PROVIDERS.filter((entry) => entry.door === 'account');
    const items: Array<{ provider_id: string; door: AuthDoor; status: CredentialRecord }> = [];
    for (const entry of accountEntries) {
      try {
        const status = await resolveCredentialStatusCached(
          projectId,
          loaded.userId,
          entry.id,
          entry.door,
        );
        if (status.status !== 'absent') {
          items.push({ provider_id: entry.id, door: entry.door, status });
        }
      } catch {
        // skip providers whose probe throws — never surface a partial 500
      }
    }

    return c.json({ items });
  },
);

// ─── DELETE /v1/projects/:projectId/oauth-credentials/:providerId ──────────
projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/oauth-credentials/{providerId}',
    tags: ['projects'],
    summary: 'Disconnect an account-door credential',
    ...auth,
    request: { params: z.object({ projectId: z.string(), providerId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const providerId = c.req.param('providerId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );

    const entry = findAuthProvider(providerId, 'account');
    const adapter = entry ? deviceFlowAdapter(providerId) : undefined;
    const secretName =
      adapter?.secretName ??
      // paste-token account providers (Anthropic) have no device adapter but a
      // known secret name via their kind → secret mapping below.
      accountSecretName(entry?.producesAuthKind);
    if (!entry || !secretName) return c.json({ error: 'Not found' }, 404);

    await deleteOAuthCredentialSecret({ projectId, secretName });
    invalidateCredentialStatus(projectId, loaded.userId, entry.id, entry.door);
    return c.json({ ok: true });
  },
);

// Account-door secret names for providers without a device adapter (Anthropic's
// paste-token). Device-code providers get theirs straight off the adapter.
function accountSecretName(kind: string | undefined): string | null {
  if (kind === 'claude_subscription') return 'CLAUDE_CODE_OAUTH_TOKEN';
  return null;
}
