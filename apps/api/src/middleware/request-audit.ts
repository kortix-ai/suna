import type { Context } from 'hono';
import type { RequestAuditContext } from '../projects/lib/serializers';
import { requestClientIp } from './client-ip';

export function requestAuditContext(c: Context): RequestAuditContext {
  return {
    method: c.req.method,
    path: c.req.path,
    ip: requestClientIp(c),
    userAgent: c.req.header('user-agent') || null,
  };
}
