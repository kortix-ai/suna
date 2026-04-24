import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { getProviderFromRequest } from './providers';
import { config } from '../config';
import { db } from '../shared/db';
import {
  insertIntegration,
  listIntegrationsByAccount,
  getIntegrationById,
  deleteIntegration,
  linkSandboxIntegration,
  unlinkSandboxIntegration,
  getIntegrationForSandbox,
  updateIntegrationLastUsed,
  updateIntegrationLabel,
  getLinkedSandboxes,
  getAppSandboxLinks,
  verifySandboxOwnership,
  listSandboxIntegrations,
  listActiveSandboxesByAccount,
} from './repositories';
import type { AppEnv } from '../types';
import { resolveAccountId } from '../shared/resolve-account';

type SandboxEnv = {
  Variables: {
    sandboxId: string;
    accountId: string;
  };
};

/**
 * Notify linked sandboxes to scaffold a CONNECTOR.md for a newly connected Pipedream app.
 * Fire-and-forget — failures are logged but don't block the connection save.
 * Retries with backoff so a transient failure (sandbox booting, network blip) doesn't
 * leave the UI showing "connected" while the agent sees no connector.
 */
async function notifySandboxesConnectorSync(accountId: string, app: string, appName: string, sandboxIds: string[]) {
  const allSandboxes = await listActiveSandboxesByAccount(accountId);
  const targets = allSandboxes.filter(sb => sandboxIds.includes(sb.sandboxId) && sb.baseUrl);
  const backoffMs = [0, 1_000, 3_000, 10_000];
  await Promise.all(targets.map(async (sb) => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < backoffMs.length; attempt++) {
      if (backoffMs[attempt]) await new Promise(r => setTimeout(r, backoffMs[attempt]));
      try {
        const res = await fetch(`${sb.baseUrl}/api/pipedream/connector-sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app, app_name: appName }),
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          console.log(`[CONNECTORS] Notified sandbox ${sb.sandboxId} to scaffold connector for ${app}${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);
          return;
        }
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
    }
    console.error(`[CONNECTORS] Failed to notify sandbox ${sb.sandboxId} for ${app} after ${backoffMs.length} attempts: ${lastErr}`);
  }));
}

const connectTokenSchema = z.object({
  app: z.string().optional(),
  success_redirect_uri: z.string().optional(),
  error_redirect_uri: z.string().optional(),
});

const tokenRequestSchema = z.object({
  app: z.string().min(1),
  integration_id: z.string().uuid().optional(),
});

const proxyRequestSchema = z.object({
  app: z.string().min(1),
  method: z.string().min(1).default('GET'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  integration_id: z.string().uuid().optional(),
});

const linkSchema = z.object({
  sandbox_id: z.string().uuid(),
});

const runActionSchema = z.object({
  app: z.string().min(1),
  action_key: z.string().min(1),
  props: z.record(z.unknown()).default({}),
});

const deployTriggerSchema = z.object({
  app: z.string().min(1),
  component_key: z.string().min(1),
  configured_props: z.record(z.unknown()).default({}),
  webhook_url: z.string().url(),
});

const updateTriggerSchema = z.object({
  active: z.boolean(),
});

const webhookSchema = z.object({
  account_id: z.string(),
  app: z.string(),
  app_name: z.string().optional(),
  provider_account_id: z.string(),
  scopes: z.array(z.string()).optional(),
  status: z.enum(['active', 'revoked', 'expired', 'error']).optional(),
});

export function createIntegrationsRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/apps', async (c) => {
    try {
      const userId = c.get('userId') as string;
      const accountId = userId ? await resolveAccountId(userId) : undefined;
      const query = c.req.query('q');
      const limit = parseInt(c.req.query('limit') || '48', 10);
      const cursor = c.req.query('cursor');
      const provider = await getProviderFromRequest(c, accountId);
      const result = await provider.listApps(query, limit, cursor);
      return c.json(result);
    } catch (err) {
      console.error('[INTEGRATIONS] Error listing apps:', err);
      return c.json({ error: 'Failed to list apps' }, 500);
    }
  });

  app.post('/connect-token', async (c) => {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);

    const body = await c.req.json().catch(() => ({}));
    const parsed = connectTokenSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: 'Invalid request' });
    }

    try {
      const provider = await getProviderFromRequest(c, accountId);
      const result = await provider.createConnectToken(accountId, parsed.data.app, {
        successRedirectUri: parsed.data.success_redirect_uri,
        errorRedirectUri: parsed.data.error_redirect_uri,
      });
      return c.json(result);
    } catch (err) {
      console.error('[INTEGRATIONS] Error creating connect token:', err);
      return c.json({ error: 'Failed to create connect token' }, 500);
    }
  });

  app.post('/connections/save', async (c) => {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);

    const body = await c.req.json();
    const saveSchema = z.object({
      app: z.string().min(1),
      app_name: z.string().optional(),
      provider_account_id: z.string().min(1),
      label: z.string().max(255).optional(),
      sandbox_id: z.string().uuid().optional(),
    });
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: 'app and provider_account_id are required' });
    }

    try {
      const provider = await getProviderFromRequest(c, accountId);
      const row = await insertIntegration({
        accountId,
        app: parsed.data.app,
        appName: parsed.data.app_name,
        providerName: provider.name,
        providerAccountId: parsed.data.provider_account_id,
        label: parsed.data.label,
      });

      const link = {
        attempted: false,
        linked: false,
        reason: null as string | null,
        linkedSandboxIds: [] as string[],
      };

      if (row) {
        if (parsed.data.sandbox_id) {
          // Explicit sandbox_id provided → link to that specific sandbox
          link.attempted = true;
          const sandboxOwned = await verifySandboxOwnership(parsed.data.sandbox_id, accountId);
          if (sandboxOwned) {
            await linkSandboxIntegration(parsed.data.sandbox_id, row.integrationId);
            console.log(`[INTEGRATIONS] Auto-linked: ${parsed.data.app} → sandbox ${parsed.data.sandbox_id}`);
            link.linked = true;
            link.linkedSandboxIds.push(parsed.data.sandbox_id);
          } else {
            console.warn(
              `[INTEGRATIONS] Auto-link skipped: sandbox not owned by account. app=${parsed.data.app} sandbox=${parsed.data.sandbox_id} account=${accountId}`,
            );
            link.reason = 'sandbox_not_owned';
          }
        } else {
          // No sandbox_id → auto-link to ALL active sandboxes owned by this account
          link.attempted = true;
          const accountSandboxes = await listActiveSandboxesByAccount(accountId);
          for (const sb of accountSandboxes) {
            await linkSandboxIntegration(sb.sandboxId, row.integrationId);
            link.linkedSandboxIds.push(sb.sandboxId);
          }
          link.linked = link.linkedSandboxIds.length > 0;
          if (link.linkedSandboxIds.length > 0) {
            console.log(
              `[INTEGRATIONS] Auto-linked ${parsed.data.app} to ${link.linkedSandboxIds.length} sandbox(es) for account ${accountId}`,
            );
          }
        }
      }

      console.log(`[INTEGRATIONS] Saved: ${parsed.data.app} for account ${accountId}`);

      // Fire-and-forget: notify linked sandboxes to scaffold a CONNECTOR.md
      if (link.linkedSandboxIds.length > 0) {
        notifySandboxesConnectorSync(accountId, parsed.data.app, parsed.data.app_name || parsed.data.app, link.linkedSandboxIds).catch(() => {});
      }

      return c.json({ success: true, integration: row, link });
    } catch (err) {
      console.error('[INTEGRATIONS] Error saving connection:', err);
      return c.json({ error: 'Failed to save connection' }, 500);
    }
  });

  // Sync: pull accounts from Pipedream and save any missing ones locally
  app.post('/connections/sync', async (c) => {
    try {
      const userId = c.get('userId') as string;
      const accountId = await resolveAccountId(userId);
      const provider = await getProviderFromRequest(c, accountId);

      // Get all Pipedream accounts for this user
      const pdAccounts = await provider.listAccounts(accountId);
      // Get existing local connections
      const existing = await listIntegrationsByAccount(accountId);
      const existingProviderIds = new Set(existing.map((e) => e.providerAccountId));

      let synced = 0;
      for (const pd of pdAccounts) {
        if (!existingProviderIds.has(pd.id)) {
          await insertIntegration({
            accountId,
            app: pd.app,
            appName: pd.appName,
            providerName: provider.name,
            providerAccountId: pd.id,
          });
          synced++;
          console.log(`[INTEGRATIONS] Synced: ${pd.app} (${pd.id}) for account ${accountId}`);
        }
      }

      const rows = await listIntegrationsByAccount(accountId);
      return c.json({ connections: rows, synced });
    } catch (err) {
      console.error('[INTEGRATIONS] Sync error:', err);
      return c.json({ error: 'Failed to sync connections' }, 500);
    }
  });

  app.get('/connections', async (c) => {
    try {
      const userId = c.get('userId') as string;
      console.log('[INTEGRATIONS] GET /connections userId:', userId);
      const accountId = await resolveAccountId(userId);
      console.log('[INTEGRATIONS] GET /connections accountId:', accountId);
      const rows = await listIntegrationsByAccount(accountId);
      console.log('[INTEGRATIONS] GET /connections rows:', rows.length);
      return c.json({ connections: rows });
    } catch (err) {
      console.error('[INTEGRATIONS] GET /connections error:', err);
      return c.json({ connections: [] }, 500);
    }
  });

  app.get('/connections/:integrationId', async (c) => {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    const { integrationId } = c.req.param();

    const row = await getIntegrationById(integrationId);
    if (!row || row.accountId !== accountId) {
      throw new HTTPException(404, { message: 'Integration not found' });
    }

    return c.json(row);
  });

  app.patch('/connections/:integrationId/label', async (c) => {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    const { integrationId } = c.req.param();

    const body = await c.req.json();
    const labelSchema = z.object({
      label: z.string().min(1).max(255),
    });
    const parsed = labelSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: 'label is required (1-255 chars)' });
    }

    const row = await getIntegrationById(integrationId);
    if (!row || row.accountId !== accountId) {
      throw new HTTPException(404, { message: 'Integration not found' });
    }

    const updated = await updateIntegrationLabel(integrationId, parsed.data.label);
    return c.json({ success: true, integration: updated });
  });

  app.get('/connections/:integrationId/sandboxes', async (c) => {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    const { integrationId } = c.req.param();

    const row = await getIntegrationById(integrationId);
    if (!row || row.accountId !== accountId) {
      throw new HTTPException(404, { message: 'Integration not found' });
    }

    const linkedSandboxes = await getLinkedSandboxes(integrationId);
    const appLinks = await getAppSandboxLinks(accountId, row.app);

    return c.json({
      sandboxes: linkedSandboxes,
      appSandboxLinks: appLinks,
    });
  });

  app.delete('/connections/:integrationId', async (c) => {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    const { integrationId } = c.req.param();

    const row = await getIntegrationById(integrationId);
    if (!row || row.accountId !== accountId) {
      throw new HTTPException(404, { message: 'Integration not found' });
    }

    try {
      const provider = await getProviderFromRequest(c, accountId);
      await provider.deleteAccount(accountId, row.providerAccountId as string);
    } catch (err) {
      console.error('[INTEGRATIONS] Error revoking on provider:', err);
    }

    await deleteIntegration(integrationId);
    return c.json({ success: true });
  });

  app.post('/connections/:integrationId/link', async (c) => {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    const { integrationId } = c.req.param();

    const body = await c.req.json();
    const parsed = linkSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: 'sandbox_id is required' });
    }

    const integration = await getIntegrationById(integrationId);
    if (!integration || integration.accountId !== accountId) {
      throw new HTTPException(404, { message: 'Integration not found' });
    }

    const sandboxOwned = await verifySandboxOwnership(parsed.data.sandbox_id, accountId);
    if (!sandboxOwned) {
      throw new HTTPException(403, { message: 'Sandbox not found or not owned by account' });
    }

    await linkSandboxIntegration(parsed.data.sandbox_id, integrationId);
    return c.json({ success: true }, 201);
  });

  app.delete('/connections/:integrationId/link/:sandboxId', async (c) => {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    const { integrationId, sandboxId } = c.req.param();

    const integration = await getIntegrationById(integrationId);
    if (!integration || integration.accountId !== accountId) {
      throw new HTTPException(404, { message: 'Integration not found' });
    }

    await unlinkSandboxIntegration(sandboxId, integrationId);
    return c.json({ success: true });
  });

  app.post('/connections/proxy', async (c) => {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);

    const body = await c.req.json();
    const parsed = proxyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: 'Invalid proxy request: app, url are required' });
    }

    const { app: appSlug, method, url, headers, body: reqBody, integration_id } = parsed.data;
    let providerAccountId: string | undefined;
    if (integration_id) {
      const integration = await getIntegrationById(integration_id);
      if (integration && integration.accountId === accountId) {
        providerAccountId = integration.providerAccountId;
      }
    }

    try {
      const provider = await getProviderFromRequest(c, accountId);
      const result = await provider.proxyRequest(accountId, appSlug, {
        method,
        url,
        headers,
        body: reqBody,
      }, providerAccountId);

      console.log(`[INTEGRATIONS] User proxy: app=${appSlug} ${method} ${url} → ${result.status}`);
      c.header('Cache-Control', 'no-store');
      return c.json({
        status: result.status,
        body: result.body,
      });
    } catch (err) {
      console.error(`[INTEGRATIONS] User proxy failed for ${appSlug}:`, err);
      return c.json({ error: `Proxy request failed: ${err}` }, 502);
    }
  });

  app.post('/webhook', async (c) => {
    const body = await c.req.json();
    const parsed = webhookSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid webhook payload' }, 400);
    }

    const { account_id, app, app_name, provider_account_id, scopes, status } = parsed.data;

    // Verify HMAC signature if PIPEDREAM_WEBHOOK_SECRET is configured.
    // The sig is HMAC(secret, account_id) — stateless, per-user verification.
    // We created this sig when issuing the connect token and passed it in webhook_uri.
    const webhookSecret = config.PIPEDREAM_WEBHOOK_SECRET;
    if (webhookSecret) {
      const { createHmac, timingSafeEqual } = await import('crypto');
      const providedSig = c.req.query('sig') || '';
      const expectedSig = createHmac('sha256', webhookSecret).update(account_id).digest('hex');
      const sigValid = providedSig.length === expectedSig.length
        && timingSafeEqual(Buffer.from(providedSig, 'hex'), Buffer.from(expectedSig, 'hex'));
      if (!sigValid) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    try {
      const provider = await getProviderFromRequest(c, accountId);
      const row = await insertIntegration({
        accountId: account_id,
        app,
        appName: app_name,
        providerName: provider.name,
        providerAccountId: provider_account_id,
        scopes,
      });

      // Auto-link to all active sandboxes owned by this account
      if (row) {
        const accountSandboxes = await listActiveSandboxesByAccount(account_id);
        let linkedCount = 0;
        for (const sb of accountSandboxes) {
          await linkSandboxIntegration(sb.sandboxId, row.integrationId);
          linkedCount++;
        }
        if (linkedCount > 0) {
          console.log(
            `[INTEGRATIONS] Webhook auto-linked ${app} to ${linkedCount} sandbox(es) for account ${account_id}`,
          );
        }
      }

      console.log(`[INTEGRATIONS] Webhook: ${app} connected for account ${account_id}`);
      return c.json({ success: true });
    } catch (err) {
      console.error('[INTEGRATIONS] Webhook processing error:', err);
      return c.json({ error: 'Webhook processing failed' }, 500);
    }
  });

  return app;
}

export function createIntegrationsTokenRouter(): Hono<SandboxEnv> {
  const app = new Hono<SandboxEnv>();

  async function ensureSandboxIntegrationForApp(sandboxId: string, accountId: string, appSlug: string) {
    const linked = await getIntegrationForSandbox(sandboxId, appSlug, accountId);
    if (linked) return linked;

    // Auto-heal: link ALL active integrations for this app to the sandbox
    const accountIntegrations = await listIntegrationsByAccount(accountId);
    const candidates = accountIntegrations
      .filter((row) => row.app === appSlug && row.status === 'active')
      .sort((a, b) => {
        const aTime = new Date(a.updatedAt ?? a.createdAt).getTime();
        const bTime = new Date(b.updatedAt ?? b.createdAt).getTime();
        return bTime - aTime;
      });

    if (candidates.length === 0) return null;

    // Link all candidates (multiple accounts for same app are allowed)
    for (const candidate of candidates) {
      await linkSandboxIntegration(sandboxId, candidate.integrationId);
    }
    console.log(
      `[INTEGRATIONS] Auto-healed sandbox links: app=${appSlug} sandbox=${sandboxId} count=${candidates.length}`,
    );

    // Return the most recently updated one for the current request
    return await getIntegrationForSandbox(sandboxId, appSlug, accountId);
  }

  app.post('/token', async (c) => {
    const sandboxId = c.get('sandboxId') as string;
    const accountId = c.get('accountId') as string;

    if (!sandboxId) {
      throw new HTTPException(403, { message: 'This endpoint requires a sandbox token (kortix_sb_)' });
    }

    const body = await c.req.json();
    const parsed = tokenRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: 'app is required' });
    }

    const { app: appSlug, integration_id } = parsed.data;

    let linked;
    if (integration_id) {
      // Specific integration requested — look it up directly
      linked = await getIntegrationById(integration_id);
      if (!linked || linked.accountId !== accountId || linked.app !== appSlug) {
        throw new HTTPException(403, {
          message: `Integration "${integration_id}" not found or does not match app "${appSlug}"`,
        });
      }
      // Ensure it's linked to this sandbox
      await linkSandboxIntegration(sandboxId, integration_id);
    } else {
      linked = await ensureSandboxIntegrationForApp(sandboxId, accountId, appSlug);
    }

    if (!linked) {
      throw new HTTPException(403, {
        message: `No connected integration for "${appSlug}" linked to this sandbox`,
      });
    }

    try {
      const provider = await getProviderFromRequest(c, accountId);
      const token = await provider.getAuthToken(accountId, appSlug, linked.providerAccountId);

      console.log(`[INTEGRATIONS] Token fetched: app=${appSlug} sandbox=${sandboxId} account=${accountId}`);
      await updateIntegrationLastUsed(linked.integrationId as string);

      c.header('Cache-Control', 'no-store');
      return c.json({
        access_token: token.accessToken,
        token_type: token.tokenType || 'Bearer',
        app: appSlug,
      });
    } catch (err) {
      console.error(`[INTEGRATIONS] Token fetch failed for ${appSlug}:`, err);
      throw new HTTPException(502, { message: `Failed to retrieve token for "${appSlug}"` });
    }
  });

  app.post('/proxy', async (c) => {
    const sandboxId = c.get('sandboxId') as string;
    const accountId = c.get('accountId') as string;

    if (!sandboxId) {
      throw new HTTPException(403, { message: 'This endpoint requires a sandbox token (kortix_sb_)' });
    }

    const body = await c.req.json();
    const parsed = proxyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: 'Invalid proxy request: app, method, and url are required' });
    }

    const { app: appSlug, method, url, headers, body: reqBody } = parsed.data;

    const linked = await ensureSandboxIntegrationForApp(sandboxId, accountId, appSlug);
    if (!linked) {
      throw new HTTPException(403, {
        message: `No connected integration for "${appSlug}" linked to this sandbox`,
      });
    }

    try {
      const provider = await getProviderFromRequest(c, accountId);
      const result = await provider.proxyRequest(accountId, appSlug, {
        method,
        url,
        headers,
        body: reqBody,
      }, linked.providerAccountId);

      console.log(`[INTEGRATIONS] Proxy: app=${appSlug} ${method} ${url} → ${result.status} sandbox=${sandboxId}`);
      await updateIntegrationLastUsed(linked.integrationId as string);

      c.header('Cache-Control', 'no-store');
      return c.json({
        status: result.status,
        body: result.body,
      });
    } catch (err) {
      console.error(`[INTEGRATIONS] Proxy failed for ${appSlug}:`, err);
      throw new HTTPException(502, { message: `Proxy request failed for "${appSlug}": ${err}` });
    }
  });

  app.get('/list', async (c) => {
    const sandboxId = c.get('sandboxId') as string;
    const accountId = c.get('accountId') as string;

    if (!sandboxId) {
      throw new HTTPException(403, { message: 'This endpoint requires a sandbox token (kortix_sb_)' });
    }

    let linked = await listSandboxIntegrations(sandboxId, accountId);

    if (linked.length === 0) {
      // Auto-heal: link ALL active integrations (multiple accounts per app allowed)
      const accountIntegrations = await listIntegrationsByAccount(accountId);
      const activeIntegrations = accountIntegrations.filter((row) => row.status === 'active');

      for (const row of activeIntegrations) {
        await linkSandboxIntegration(sandboxId, row.integrationId);
      }

      linked = await listSandboxIntegrations(sandboxId, accountId);
      if (linked.length > 0) {
        console.log(
          `[INTEGRATIONS] Auto-healed sandbox links from account integrations: sandbox=${sandboxId} count=${linked.length}`,
        );
      }
    }

    return c.json({
      integrations: linked.map((l) => ({
        integrationId: l.integration.integrationId,
        app: l.integration.app,
        appName: l.integration.appName,
        label: l.integration.label,
        status: l.integration.status,
      })),
    });
  });

  app.get('/actions', async (c) => {
    const sandboxId = c.get('sandboxId') as string;
    const accountId = c.get('accountId') as string;

    if (!sandboxId) {
      throw new HTTPException(403, { message: 'This endpoint requires a sandbox token (kortix_sb_)' });
    }

    const appSlug = c.req.query('app');
    if (!appSlug) {
      throw new HTTPException(400, { message: 'app query parameter is required' });
    }

    const query = c.req.query('q');
    const limit = parseInt(c.req.query('limit') || '50', 10);

    try {
      const provider = await getProviderFromRequest(c, accountId);
      const result = await provider.listActions(appSlug, query, limit);
      return c.json(result);
    } catch (err) {
      console.error(`[INTEGRATIONS] Error listing actions for ${appSlug}:`, err);
      return c.json({ error: `Failed to list actions for "${appSlug}"` }, 500);
    }
  });

  app.post('/connect', async (c) => {
    const sandboxId = c.get('sandboxId') as string;
    const accountId = c.get('accountId') as string;

    if (!sandboxId) {
      throw new HTTPException(403, { message: 'This endpoint requires a sandbox token (kortix_sb_)' });
    }

    const body = await c.req.json();
    const parsed = tokenRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: 'app is required' });
    }

    const { app: appSlug } = parsed.data;

    try {
      const provider = await getProviderFromRequest(c, accountId);
      const result = await provider.createConnectToken(accountId, appSlug);

      const dashboardUrl = `${config.FRONTEND_URL}/connectors?connect=${encodeURIComponent(appSlug)}&sandbox_id=${encodeURIComponent(sandboxId)}`;
      console.log(`[INTEGRATIONS] Connect token created: app=${appSlug} sandbox=${sandboxId} account=${accountId}`);
      return c.json({
        connectUrl: dashboardUrl,
        token: result.token,
        app: appSlug,
      });
    } catch (err) {
      console.error(`[INTEGRATIONS] Connect token failed for ${appSlug}:`, err);
      const detail = err instanceof Error ? err.message : String(err);
      throw new HTTPException(502, { message: `Failed to create connect token for "${appSlug}": ${detail}` });
    }
  });

  app.get('/search-apps', async (c) => {
    const sandboxId = c.get('sandboxId') as string;
    const accountId = c.get('accountId') as string;

    if (!sandboxId) {
      throw new HTTPException(403, { message: 'This endpoint requires a sandbox token (kortix_sb_)' });
    }

    const query = c.req.query('q');
    const limit = parseInt(c.req.query('limit') || '20', 10);

    try {
      const provider = await getProviderFromRequest(c, accountId);
      const result = await provider.listApps(query, limit);
      return c.json(result);
    } catch (err) {
      console.error('[INTEGRATIONS] Error searching apps:', err);
      return c.json({ error: 'Failed to search apps' }, 500);
    }
  });

  app.post('/run-action', async (c) => {
    const sandboxId = c.get('sandboxId') as string;
    const accountId = c.get('accountId') as string;

    if (!sandboxId) {
      throw new HTTPException(403, { message: 'This endpoint requires a sandbox token (kortix_sb_)' });
    }

    const body = await c.req.json();
    const parsed = runActionSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: 'app, action_key are required' });
    }

    const { app: appSlug, action_key, props } = parsed.data;

    const linked = await ensureSandboxIntegrationForApp(sandboxId, accountId, appSlug);
    if (!linked) {
      throw new HTTPException(403, {
        message: `No connected integration for "${appSlug}" linked to this sandbox`,
      });
    }

    try {
      const provider = await getProviderFromRequest(c, accountId);
      const result = await provider.runAction(accountId, action_key, props, appSlug, linked.providerAccountId);

      console.log(`[INTEGRATIONS] Action run: ${action_key} app=${appSlug} sandbox=${sandboxId} success=${result.success}`);
      await updateIntegrationLastUsed(linked.integrationId as string);

      c.header('Cache-Control', 'no-store');
      return c.json(result);
    } catch (err) {
      console.error(`[INTEGRATIONS] Action run failed for ${action_key}:`, err);
      throw new HTTPException(502, { message: `Action execution failed: ${err}` });
    }
  });

  // ─── Trigger management routes ──────────────────────────────────────────────

  app.get('/triggers/available', async (c) => {
    const accountId = c.get('accountId') as string;
    const appSlug = c.req.query('app');
    const query = c.req.query('q');
    const limit = c.req.query('limit');

    if (!appSlug) {
      throw new HTTPException(400, { message: 'app query parameter is required' });
    }

    try {
      const provider = await getProviderFromRequest(c, accountId);
      if (!provider.listAvailableTriggers) {
        throw new HTTPException(501, { message: 'Provider does not support triggers' });
      }
      const triggers = await provider.listAvailableTriggers(appSlug, query ?? undefined, limit ? parseInt(limit) : undefined);
      console.log(`[INTEGRATIONS] Listed available triggers: app=${appSlug} count=${triggers.length} account=${accountId}`);
      return c.json({ triggers });
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error(`[INTEGRATIONS] List available triggers failed for ${appSlug}:`, err);
      throw new HTTPException(502, { message: `Failed to list triggers: ${err}` });
    }
  });

  app.post('/triggers/deploy', async (c) => {
    const sandboxId = c.get('sandboxId') as string;
    const accountId = c.get('accountId') as string;

    if (!sandboxId) {
      throw new HTTPException(403, { message: 'This endpoint requires a sandbox token (kortix_sb_)' });
    }

    const body = await c.req.json();
    const parsed = deployTriggerSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: 'app, component_key, and webhook_url are required' });
    }

    const { app: appSlug, component_key, configured_props, webhook_url } = parsed.data;

    // Verify user has connected this app
    const linked = await ensureSandboxIntegrationForApp(sandboxId, accountId, appSlug);
    if (!linked) {
      throw new HTTPException(403, {
        message: `No connected integration for "${appSlug}" linked to this sandbox. Connect it first.`,
      });
    }

    try {
      const provider = await getProviderFromRequest(c, accountId);
      if (!provider.deployTrigger) {
        throw new HTTPException(501, { message: 'Provider does not support triggers' });
      }
      const result = await provider.deployTrigger(accountId, appSlug, component_key, configured_props, webhook_url);
      console.log(`[INTEGRATIONS] Trigger deployed: ${component_key} app=${appSlug} sandbox=${sandboxId} deployedId=${result.deployedTriggerId}`);
      await updateIntegrationLastUsed(linked.integrationId as string);

      c.header('Cache-Control', 'no-store');
      return c.json(result);
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error(`[INTEGRATIONS] Trigger deploy failed for ${component_key}:`, err);
      throw new HTTPException(502, { message: `Trigger deployment failed: ${err}` });
    }
  });

  app.get('/triggers/deployed', async (c) => {
    const accountId = c.get('accountId') as string;

    try {
      const provider = await getProviderFromRequest(c, accountId);
      if (!provider.listDeployedTriggers) {
        throw new HTTPException(501, { message: 'Provider does not support triggers' });
      }
      const result = await provider.listDeployedTriggers(accountId);
      console.log(`[INTEGRATIONS] Listed deployed triggers: count=${result.triggers.length} account=${accountId}`);
      return c.json(result);
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error(`[INTEGRATIONS] List deployed triggers failed:`, err);
      throw new HTTPException(502, { message: `Failed to list deployed triggers: ${err}` });
    }
  });

  app.delete('/triggers/deployed/:id', async (c) => {
    const accountId = c.get('accountId') as string;
    const deployedTriggerId = c.req.param('id');

    try {
      const provider = await getProviderFromRequest(c, accountId);
      if (!provider.deleteDeployedTrigger) {
        throw new HTTPException(501, { message: 'Provider does not support triggers' });
      }
      await provider.deleteDeployedTrigger(accountId, deployedTriggerId);
      console.log(`[INTEGRATIONS] Trigger deleted: ${deployedTriggerId} account=${accountId}`);
      return c.json({ success: true });
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error(`[INTEGRATIONS] Trigger delete failed for ${deployedTriggerId}:`, err);
      throw new HTTPException(502, { message: `Trigger deletion failed: ${err}` });
    }
  });

  app.put('/triggers/deployed/:id', async (c) => {
    const accountId = c.get('accountId') as string;
    const deployedTriggerId = c.req.param('id');

    const body = await c.req.json();
    const parsed = updateTriggerSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: 'active (boolean) is required' });
    }

    try {
      const provider = await getProviderFromRequest(c, accountId);
      const method = parsed.data.active ? 'resumeDeployedTrigger' : 'pauseDeployedTrigger';
      if (!provider[method]) {
        throw new HTTPException(501, { message: 'Provider does not support triggers' });
      }
      const result = await provider[method]!(accountId, deployedTriggerId);
      console.log(`[INTEGRATIONS] Trigger ${parsed.data.active ? 'resumed' : 'paused'}: ${deployedTriggerId} account=${accountId}`);
      return c.json(result);
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error(`[INTEGRATIONS] Trigger update failed for ${deployedTriggerId}:`, err);
      throw new HTTPException(502, { message: `Trigger update failed: ${err}` });
    }
  });

  return app;
}
