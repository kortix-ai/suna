import type { Context } from 'hono';
import type { RequestAuditContext } from '../../services/projects/lib/serializers';
import { requestClientIp } from './client-ip';

/** The request facts an audit row records: method, path, client address, user agent. */
export function requestAuditContext(c: Context): RequestAuditContext {
  return {
    method: c.req.method,
    path: c.req.path,
    ip: requestClientIp(c),
    userAgent: c.req.header('user-agent') || null,
  };
}
