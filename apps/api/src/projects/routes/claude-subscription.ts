// The caller's Claude subscription login, for Claude Code in their sessions.
//
//   GET    /v1/projects/:projectId/claude-subscription                 status
//   POST   /v1/projects/:projectId/claude-subscription/login/start     run `claude setup-token`
//   POST   /v1/projects/:projectId/claude-subscription/login/complete  paste the code
//   PUT    /v1/projects/:projectId/claude-subscription/token           paste a token
//   DELETE /v1/projects/:projectId/claude-subscription                 disconnect
//
// The project gives the permission context. The login belongs to the caller
// in the project's account, so it works in every project of that account.
// Only a person signs in: a sandbox, session, service-account or API-key
// credential gets 403. No response carries the token.

import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../../types';
import { auth, errors, json } from '../../openapi';
import { recordAuditEvent } from '../../shared/audit';
import { accountMemberRow } from '../../iam/membership-read';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { createProjectSecretWriteRateLimitMiddleware } from '../../middleware/rate-limit';
import { CLAUDE_TOKEN_PATTERN } from '../claude-subscription/setup-token';
import {
  ClaudeLoginFlowError,
  cancelClaudeLogins,
  completeClaudeLogin,
  onClaudeLoginChanged,
  startClaudeLogin,
} from '../claude-subscription/flows';
import { claudeLoginStatus, deleteClaudeLogin, saveClaudeLogin, type ClaudeLoginStatus } from '../../claude-subscription/store';

const Params = z.object({ projectId: z.string() });

const StatusSchema = z
  .object({
    connected: z.boolean().openapi({ description: 'The caller has a Claude subscription login in this account.' }),
    source: z.enum(['setup_token', 'pasted']).nullable().openapi({ description: 'How the login was made.' }),
    connected_at: z.string().nullable().openapi({ description: 'When the login was stored (ISO 8601).' }),
    usable: z.boolean().openapi({ description: 'False when the stored login cannot be read: sign in again.' }),
  })
  .openapi('ClaudeSubscriptionStatus');

const StartSchema = z
  .object({
    flow_id: z.string().uuid(),
    authorize_url: z.string().openapi({ description: 'The claude.com page where the caller approves the sign-in.' }),
    expires_at: z.string(),
  })
  .openapi('ClaudeSubscriptionLoginStart');

const CompleteBody = z.object({
  flow_id: z.string().uuid().openapi({ description: 'The flow id that start returned.' }),
  code: z.string().min(1).max(2048).openapi({ description: 'The code platform.claude.com showed after the approval.' }),
});

const TokenBody = z.object({
  token: z.string().openapi({ description: 'The token `claude setup-token` printed (`sk-ant-oat01-…`).' }),
});

type ProjectContext = Context<AppEnv>;

function statusBody(status: ClaudeLoginStatus) {
  return { connected: status.connected, source: status.source, connected_at: status.connectedAt, usable: status.usable };
}

/** A person, with a credential of their own: a browser session or a personal token outside any session. */
function isPersonCredential(c: ProjectContext): boolean {
  const authType = c.get('authType') as string | undefined;
  if (authType === 'supabase') return true;
  return authType === 'pat' && !c.get('sessionId');
}

type Caller = { accountId: string; userId: string; projectId: string };
type Refusal = { body: { error: string; message: string; code: string }; status: 403 | 404 };

async function caller(c: ProjectContext, projectId: string): Promise<Caller | Refusal> {
  if (!isPersonCredential(c)) {
    return {
      body: { error: 'forbidden', message: 'Only a person signs in to their Claude subscription.', code: 'person_required' },
      status: 403,
    };
  }
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { body: { error: 'not_found', message: 'Project not found', code: 'not_found' }, status: 404 };
  const [member] = await accountMemberRow(loaded.row.accountId, loaded.userId);
  if (!member) {
    return {
      body: { error: 'forbidden', message: 'Only a member of this account signs in to Claude here.', code: 'member_required' },
      status: 403,
    };
  }
  return { accountId: loaded.row.accountId, userId: loaded.userId, projectId };
}

async function audit(who: Caller, action: 'secret.claude_subscription.connected' | 'secret.claude_subscription.disconnected', source?: string) {
  await recordAuditEvent({
    accountId: who.accountId,
    projectId: who.projectId,
    actorUserId: who.userId,
    actorType: 'human',
    source: 'api',
    action,
    resourceType: 'claude_subscription_login',
    resourceId: who.userId,
    metadata: source ? { source } : {},
  });
}

export function registerClaudeSubscriptionRoutes(): void {
  // The pattern also matches `/:projectId/claude-subscription` itself.
  projectsApp.use('/:projectId/claude-subscription/*', createProjectSecretWriteRateLimitMiddleware());

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/claude-subscription',
      tags: ['secrets'],
      summary: 'Read your Claude subscription login status',
      description: 'Whether you signed in to your Claude subscription for Claude Code in this account. The token is never returned.',
      ...auth,
      request: { params: Params },
      responses: { 200: json(StatusSchema, 'Login status'), ...errors(403, 404) },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const who = await caller(c, projectId);
      if ('body' in who) return c.json(who.body, who.status);
      return c.json(statusBody(await claudeLoginStatus(who.accountId, who.userId)), 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/claude-subscription/login/start',
      tags: ['secrets'],
      summary: 'Start a Claude subscription sign-in',
      description:
        "Runs the unmodified Claude Code binary's `claude setup-token` and returns its claude.com sign-in link. Open the link, approve, then send the code claude.com shows to `login/complete`. A new start replaces your earlier one.",
      ...auth,
      request: { params: Params },
      responses: { 200: json(StartSchema, 'The sign-in link'), ...errors(403, 404, 429, 502, 503) },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const who = await caller(c, projectId);
      if ('body' in who) return c.json(who.body, who.status);
      try {
        const started = await startClaudeLogin({ accountId: who.accountId, userId: who.userId });
        return c.json({ flow_id: started.flowId, authorize_url: started.authorizeUrl, expires_at: started.expiresAt }, 200);
      } catch (err) {
        if (!(err instanceof ClaudeLoginFlowError)) throw err;
        const status = err.status === 429 || err.status === 503 ? err.status : 502;
        return c.json({ error: err.code, message: err.message, code: err.code }, status);
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/claude-subscription/login/complete',
      tags: ['secrets'],
      summary: 'Finish a Claude subscription sign-in',
      description:
        'Hands the code claude.com showed to the running `claude setup-token`, which exchanges it with Anthropic. On success the login is stored for you only. Errors: `invalid_code`, `expired`, `login_failed`.',
      ...auth,
      request: { params: Params, body: { content: { 'application/json': { schema: CompleteBody } } } },
      responses: { 200: json(StatusSchema, 'Signed in'), ...errors(400, 403, 404, 409, 410, 502) },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const body = c.req.valid('json');
      const who = await caller(c, projectId);
      if ('body' in who) return c.json(who.body, who.status);
      try {
        await completeClaudeLogin({ accountId: who.accountId, userId: who.userId, flowId: body.flow_id, code: body.code });
      } catch (err) {
        if (!(err instanceof ClaudeLoginFlowError)) throw err;
        const status = err.status === 400 || err.status === 404 || err.status === 409 || err.status === 410 ? err.status : 502;
        return c.json({ error: err.code, message: err.message, code: err.code }, status);
      }
      await audit(who, 'secret.claude_subscription.connected', 'setup_token');
      return c.json(statusBody(await claudeLoginStatus(who.accountId, who.userId)), 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{projectId}/claude-subscription/token',
      tags: ['secrets'],
      summary: 'Store a Claude subscription token you made',
      description:
        'Stores the token `claude setup-token` printed on your own computer. It is kept for you only and reaches Claude Code in your sessions. It is never returned.',
      ...auth,
      request: { params: Params, body: { content: { 'application/json': { schema: TokenBody } } } },
      responses: { 200: json(StatusSchema, 'Stored'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const token = c.req.valid('json').token.trim();
      const who = await caller(c, projectId);
      if ('body' in who) return c.json(who.body, who.status);
      if (!CLAUDE_TOKEN_PATTERN.test(token)) {
        return c.json(
          { error: 'invalid_token', message: 'Paste the whole token `claude setup-token` printed. It starts with sk-ant-oat01-.', code: 'invalid_token' },
          400,
        );
      }
      await cancelClaudeLogins(who.accountId, who.userId);
      await saveClaudeLogin(who.accountId, who.userId, token, 'pasted');
      await audit(who, 'secret.claude_subscription.connected', 'pasted');
      void onClaudeLoginChanged(who.accountId, who.userId);
      return c.json(statusBody(await claudeLoginStatus(who.accountId, who.userId)), 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/claude-subscription',
      tags: ['secrets'],
      summary: 'Disconnect your Claude subscription',
      description: 'Deletes your stored Claude login in this account and removes it from your running sessions.',
      ...auth,
      request: { params: Params },
      responses: { 200: json(StatusSchema, 'Disconnected'), ...errors(403, 404) },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const who = await caller(c, projectId);
      if ('body' in who) return c.json(who.body, who.status);
      await cancelClaudeLogins(who.accountId, who.userId);
      if (await deleteClaudeLogin(who.accountId, who.userId)) {
        await audit(who, 'secret.claude_subscription.disconnected');
        void onClaudeLoginChanged(who.accountId, who.userId);
      }
      return c.json(statusBody(await claudeLoginStatus(who.accountId, who.userId)), 200);
    },
  );
}
