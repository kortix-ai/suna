import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppContext } from '../../types';
import { verifySessionConnectorToken } from '../../shared/session-connector-token';
import {
  findActiveProjectConnector,
  listActiveProjectConnectors,
  serializeProjectConnector,
  touchProjectConnectorLastUsed,
} from '../../projects/connectors';
import { getProviderFromRequest } from '../../integrations/providers';

const sessionConnectors = new Hono<{ Variables: AppContext }>();

const connectorSelectorSchema = z.object({
  connector_id: z.string().uuid().optional(),
  app: z.string().min(1).optional(),
});

const proxyRequestSchema = connectorSelectorSchema.extend({
  method: z.string().min(1).default('GET'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

const runActionSchema = connectorSelectorSchema.extend({
  action_key: z.string().min(1),
  props: z.record(z.unknown()).default({}),
});

function bearerToken(c: any): string | null {
  const header = c.req.header('Authorization') || c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

async function resolveConnectorContext(c: any) {
  const verified = verifySessionConnectorToken(bearerToken(c));
  if (!verified.ok) {
    throw new HTTPException(401, { message: `Invalid connector token: ${verified.reason}` });
  }
  return verified.context;
}

async function readJson(c: any) {
  try {
    return await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  }
}

async function resolveActiveConnector(
  ctx: Awaited<ReturnType<typeof resolveConnectorContext>>,
  selector: { connector_id?: string; app?: string },
) {
  const connector = await findActiveProjectConnector({
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    connectorId: selector.connector_id ?? null,
    app: selector.app ?? null,
  });

  if (!connector) {
    throw new HTTPException(403, {
      message: selector.connector_id
        ? `Connector "${selector.connector_id}" is not active for this session project`
        : `No active project connector for app "${selector.app}"`,
    });
  }

  return connector;
}

async function listConnectors(c: any) {
  const ctx = await resolveConnectorContext(c);
  const rows = await listActiveProjectConnectors(ctx.accountId, ctx.projectId);
  return c.json({
    connectors: rows.map((row) => serializeProjectConnector(row)),
  });
}

sessionConnectors.get('/', listConnectors);
sessionConnectors.get('/list', listConnectors);

sessionConnectors.get('/search-apps', async (c) => {
  const ctx = await resolveConnectorContext(c);
  const query = c.req.query('q');
  const limit = parseInt(c.req.query('limit') || '20', 10);

  try {
    const provider = await getProviderFromRequest(c as any, ctx.accountId);
    return c.json(await provider.listApps(query, limit));
  } catch (error) {
    throw new HTTPException(502, { message: `Failed to search connector apps: ${error}` });
  }
});

sessionConnectors.get('/actions', async (c) => {
  const ctx = await resolveConnectorContext(c);
  const parsed = connectorSelectorSchema.safeParse({
    connector_id: c.req.query('connector_id'),
    app: c.req.query('app'),
  });
  if (!parsed.success || (!parsed.data.connector_id && !parsed.data.app)) {
    throw new HTTPException(400, { message: 'connector_id or app query parameter is required' });
  }

  const connector = await resolveActiveConnector(ctx, parsed.data);
  const query = c.req.query('q');
  const limit = parseInt(c.req.query('limit') || '50', 10);
  try {
    const provider = await getProviderFromRequest(c as any, ctx.accountId);
    return c.json(await provider.listActions(connector.app, query, limit));
  } catch (error) {
    throw new HTTPException(502, { message: `Failed to list actions for "${connector.app}": ${error}` });
  }
});

sessionConnectors.post('/proxy', async (c) => {
  const ctx = await resolveConnectorContext(c);
  const parsed = proxyRequestSchema.safeParse(await readJson(c));
  if (!parsed.success || (!parsed.data.connector_id && !parsed.data.app)) {
    throw new HTTPException(400, { message: 'connector_id or app plus method and url are required' });
  }

  const connector = await resolveActiveConnector(ctx, parsed.data);
  try {
    const provider = await getProviderFromRequest(c as any, ctx.accountId);
    const result = await provider.proxyRequest(ctx.accountId, connector.app, {
      method: parsed.data.method,
      url: parsed.data.url,
      headers: parsed.data.headers,
      body: parsed.data.body,
    }, connector.providerAccountId);

    await touchProjectConnectorLastUsed(connector.connectorId);
    c.header('Cache-Control', 'no-store');
    return c.json({
      status: result.status,
      headers: result.headers,
      body: result.body,
    });
  } catch (error) {
    throw new HTTPException(502, { message: `Connector proxy failed for "${connector.app}": ${error}` });
  }
});

sessionConnectors.post('/run-action', async (c) => {
  const ctx = await resolveConnectorContext(c);
  const parsed = runActionSchema.safeParse(await readJson(c));
  if (!parsed.success || (!parsed.data.connector_id && !parsed.data.app)) {
    throw new HTTPException(400, { message: 'connector_id or app plus action_key are required' });
  }

  const connector = await resolveActiveConnector(ctx, parsed.data);
  try {
    const provider = await getProviderFromRequest(c as any, ctx.accountId);
    const result = await provider.runAction(
      ctx.accountId,
      parsed.data.action_key,
      parsed.data.props,
      connector.app,
      connector.providerAccountId,
    );

    await touchProjectConnectorLastUsed(connector.connectorId);
    c.header('Cache-Control', 'no-store');
    return c.json(result);
  } catch (error) {
    throw new HTTPException(502, { message: `Connector action failed for "${connector.app}": ${error}` });
  }
});

export { sessionConnectors };
