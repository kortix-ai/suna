import { Hono } from 'hono';
import { eq, and, or } from 'drizzle-orm';
import { tunnelConnections, tunnelPermissionRequests } from '@kortix/db';
import { db } from '../../shared/db';
import { TunnelRelayError, TunnelMethods, TunnelErrorCode, type TunnelCapability } from 'agent-tunnel';
import { tunnelRelay } from '../core/relay';
import { checkPermission } from '../core/permission-checker';
import { writeAuditLog, buildRequestSummary } from '../core/audit-logger';
import { notifyPermissionRequest } from './permission-requests';
import { tunnelRateLimiter } from '../core/rate-limiter';
import { isValidCapability, validateScope as validateScopeInput } from '../core/scope-validator';
import { resolveAccountId } from '../../shared/resolve-account';

export function createRpcRouter(): Hono {
  const router = new Hono();

  router.post('/:tunnelId', async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = (c.get('accountId') as string | undefined) || await resolveAccountId(userId);
    const tunnelId = c.req.param('tunnelId');

    const rpcRateCheck = tunnelRateLimiter.check('rpc', tunnelId);
    if (!rpcRateCheck.allowed) {
      return c.json({
        error: 'Rate limit exceeded',
        code: TunnelErrorCode.RATE_LIMITED,
        retryAfterMs: rpcRateCheck.retryAfterMs,
      }, 429);
    }

    const body = await c.req.json();
    const { method, params = {} } = body;

    if (!method || typeof method !== 'string') {
      return c.json({ error: 'method is required' }, 400);
    }

    const ownerClause = accountId !== userId
      ? or(eq(tunnelConnections.accountId, accountId), eq(tunnelConnections.accountId, userId))
      : eq(tunnelConnections.accountId, accountId);

    const [tunnel] = await db
      .select()
      .from(tunnelConnections)
      .where(
        and(
          eq(tunnelConnections.tunnelId, tunnelId),
          ownerClause,
        ),
      );

    if (!tunnel) {
      return c.json({ error: 'Tunnel connection not found' }, 404);
    }

    const capability = resolveCapability(method);
    if (!capability) {
      return c.json({ error: `Unknown method: ${method}` }, 400);
    }

    if (!isValidCapability(capability)) {
      return c.json({ error: `Invalid capability: ${capability}` }, 400);
    }

    const capPrefix = method.indexOf('.');
    const operation = capPrefix !== -1 ? method.slice(capPrefix + 1) : method;
    const permCheck = await checkPermission(tunnelId, capability, operation, params);

    if (!permCheck.allowed) {
      const permReqRateCheck = tunnelRateLimiter.check('permRequest', accountId);
      if (!permReqRateCheck.allowed) {
        return c.json({
          error: 'Too many permission requests',
          code: TunnelErrorCode.RATE_LIMITED,
          retryAfterMs: permReqRateCheck.retryAfterMs,
        }, 429);
      }

      const scopeValidation = validateScopeInput(capability, params);
      const requestedScope = scopeValidation.valid ? (scopeValidation.sanitized || params) : params;

      const [request] = await db
        .insert(tunnelPermissionRequests)
        .values({
          tunnelId,
          accountId,
          capability,
          requestedScope,
          reason: `Agent requested ${method} — ${permCheck.reason}`,
        })
        .returning();

      notifyPermissionRequest(accountId, request);

      return c.json(
        {
          error: 'Permission required',
          code: TunnelErrorCode.PERMISSION_DENIED,
          requestId: request.requestId,
          message: permCheck.reason,
        },
        403,
      );
    }

    const startTime = Date.now();

    try {
      const result = await tunnelRelay.relayRPC(tunnelId, method, {
        ...params,
        permissionId: permCheck.permissionId,
      });

      const durationMs = Date.now() - startTime;

      writeAuditLog({
        tunnelId,
        accountId,
        capability,
        operation: method,
        requestSummary: buildRequestSummary(method, params),
        success: true,
        durationMs,
        bytesTransferred: estimateBytes(result),
      });

      return c.json({ result });
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof TunnelRelayError ? err.code : TunnelErrorCode.LOCAL_ERROR;

      writeAuditLog({
        tunnelId,
        accountId,
        capability,
        operation: method,
        requestSummary: buildRequestSummary(method, params),
        success: false,
        durationMs,
        errorMessage,
      });

      const httpStatus = errorCode === TunnelErrorCode.NOT_CONNECTED ? 502
        : errorCode === TunnelErrorCode.TIMEOUT ? 504
        : 500;

      return c.json({ error: errorMessage, code: errorCode }, httpStatus);
    }
  });

  return router;
}

function resolveCapability(method: string): TunnelCapability | null {
  const mapped = (TunnelMethods as Record<string, string | null>)[method];
  if (mapped !== undefined) {
    return mapped as TunnelCapability | null;
  }

  const prefix = method.split('.')[0];
  const prefixMap: Record<string, TunnelCapability> = {
    fs: 'filesystem',
    shell: 'shell',
    net: 'network',
    desktop: 'desktop',
    apps: 'apps',
    hardware: 'hardware',
    gpu: 'gpu',
  };

  return prefixMap[prefix] || null;
}

function estimateBytes(result: unknown): number {
  if (result === null || result === undefined) return 0;
  if (typeof result === 'string') return result.length;
  try {
    return JSON.stringify(result).length;
  } catch {
    return 0;
  }
}
