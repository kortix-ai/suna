/**
 * The audit boundary for everything that reaches the API process.
 *
 * `Bun.serve.fetch` wraps its whole dispatcher in {@link runInboundAudit}.
 * That is the one place every inbound request passes, whichever way it is
 * routed afterwards: the Hono app, a preview subdomain, a deployed-app origin,
 * or a WebSocket upgrade (the PTY terminal, the tunnel agent, preview/app
 * sockets). Before this, only the Hono app was audited, and only `/v1/*`.
 *
 * The request context (AsyncLocalStorage) is opened HERE, so the non-Hono
 * entrypoints get the request id, trace id and audit scope that Hono routes
 * always had. The Hono request-context middleware reuses it instead of
 * opening a second one.
 *
 * The row is written after the response is known and never delays it: in
 * production the write is tracked and `flushAuditEvents()` waits for it; in
 * synchronous test mode it is awaited so a test can read it back at once.
 */
import { runWithContext } from '../lib/request-context';
import {
  auditWritesAreSynchronous,
  emitInboundAuditRow,
  trackInboundAuditEmission,
} from './audit';
import { attachInboundAuditScope, isUnauditedInbound } from './audit-scope';

/** HTTP 101: the handshake became a socket. `server.upgrade()` returns none. */
const SWITCHING_PROTOCOLS = 101;

export async function runInboundAudit(
  req: Request,
  url: URL,
  dispatch: () => Promise<Response | undefined>,
): Promise<Response | undefined> {
  if (isUnauditedInbound(req.method, url.pathname)) return dispatch();
  return runWithContext(
    req.method,
    url.pathname,
    async () => {
      const scope = attachInboundAuditScope({
        owner: 'edge',
        method: req.method,
        headers: req.headers,
        url,
      });
      let response: Response | undefined;
      let failed = false;
      try {
        response = await dispatch();
        return response;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        // Prefer the status the innermost layer saw: the wire rewrite that
        // turns a 502 into a 503 must not rewrite the audit record too.
        const status =
          scope.status ?? (failed ? 500 : (response?.status ?? SWITCHING_PROTOCOLS));
        const emission = emitInboundAuditRow(scope, status);
        if (auditWritesAreSynchronous()) await emission;
        else trackInboundAuditEmission(emission);
      }
    },
    req.headers.get('traceparent'),
  );
}
