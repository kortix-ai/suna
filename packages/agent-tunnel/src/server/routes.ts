import { Hono } from 'hono';
import type { TunnelRelay } from './relay';
import { TunnelRelayError } from './relay';
import { TunnelErrorCode } from '../shared/types';

export function createTunnelRouter(
  relay: TunnelRelay,
  onAuthorizeHTTP?: (req: Request) => Promise<boolean>,
): Hono {
  const router = new Hono();

  if (onAuthorizeHTTP) {
    router.use('*', async (c, next) => {
      const authorized = await onAuthorizeHTTP(c.req.raw);
      if (!authorized) {
        return c.json({ error: 'Unauthorized' }, 403);
      }
      await next();
    });
  }

  router.get('/connections', (c) => {
    const agents = relay.getConnectedAgents();
    const list = Array.from(agents.values()).map((a) => ({
      tunnelId: a.tunnelId,
      connectedAt: a.connectedAt,
      metadata: a.metadata,
    }));
    return c.json({ connections: list, total: list.length });
  });

  router.get('/connections/:id', (c) => {
    const id = c.req.param('id');
    const agents = relay.getConnectedAgents();
    const agent = agents.get(id);
    if (!agent) {
      return c.json({ error: 'Agent not connected' }, 404);
    }
    return c.json({
      tunnelId: agent.tunnelId,
      connectedAt: agent.connectedAt,
      metadata: agent.metadata,
      connected: true,
    });
  });

  router.post('/rpc/:tunnelId', async (c) => {
    const tunnelId = c.req.param('tunnelId');
    const body = await c.req.json();
    const { method, params = {}, timeoutMs } = body;

    if (!method || typeof method !== 'string') {
      return c.json({ error: 'method is required' }, 400);
    }

    try {
      const result = await relay.relayRPC(tunnelId, method, params, {
        timeoutMs: timeoutMs ?? undefined,
      });
      return c.json({ result });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof TunnelRelayError ? err.code : TunnelErrorCode.LOCAL_ERROR;

      const httpStatus = errorCode === TunnelErrorCode.NOT_CONNECTED ? 502
        : errorCode === TunnelErrorCode.TIMEOUT ? 504
        : errorCode === TunnelErrorCode.PERMISSION_DENIED ? 403
        : 500;

      return c.json({ error: errorMessage, code: errorCode }, httpStatus);
    }
  });

  return router;
}
