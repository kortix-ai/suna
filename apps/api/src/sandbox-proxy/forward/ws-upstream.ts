import { ingressTargetUrl } from '../../platform/providers/ingress-url';
import { KORTIX_USER_CONTEXT_HEADER } from '../../shared/kortix-user-context';
import { canAccessPreviewSandbox, canAccessSandboxSession } from '../../shared/preview-ownership';
import {
  buildSandboxUpstreamHeaders,
  loadSandbox,
  resolveSandboxIngress,
  routeSandboxIngress,
} from '../backend';
import { canonicalProxyPath } from '../proxy-path';
import { carriesSessionData, requiresSessionVisibility } from '../session-data-ports';
import { resumeAndReloadSandbox, shouldWakeStoppedSandboxForWsAttach } from './wake';

// === WebSocket upstream resolution =============================================
//
// Resolves the upstream WS URL + auth headers for a preview WebSocket. The
// actual upgrade + byte-piping happens at the Bun.serve level (ws-proxy.ts);
// this reuses the exact same ownership gate, service key, and signed
// user-context as the HTTP forwarder so the security posture is identical.

export async function resolvePreviewWsUpstream(opts: {
  sandboxId: string;
  upstreamPort: number;
  userId: string;
  remainingPath: string;
  queryString: string;
  /** The caller's own session when the credential is bound to one, or null for a
   *  principal that is not session-bound. REQUIRED — fail closed, never default. */
  callerSessionId: string | null;
  /** The caller's AGENT/SANDBOX token binding. Only the trigger-session manager
   *  override reads it (connectors/share.ts). REQUIRED, same reasoning. */
  boundCredentialSessionId: string | null;
  /** The client marked this attach as user-initiated (`wake=1`): the panel's
   *  first connect, or "Reconnect now". Automatic backoff retries never set it.
   *  See `shouldWakeStoppedSandboxForWsAttach`. */
  wakeRequested?: boolean;
}): Promise<
  | { ok: true; url: string; headers: Record<string, string> }
  | { ok: false; status: number; message: string }
> {
  const { sandboxId, userId, queryString } = opts;
  // Same single spelling as the HTTP forwarder (`../proxy-path.ts`).
  const remainingPath = canonicalProxyPath(opts.remainingPath, carriesSessionData(opts.upstreamPort));
  if (remainingPath === null) return { ok: false, status: 400, message: 'invalid request path' };
  const callerSessionId = opts.callerSessionId;
  const boundCredentialSessionId = opts.boundCredentialSessionId;

  let record = await loadSandbox(sandboxId);
  if (!record) return { ok: false, status: 404, message: 'sandbox not found' };

  const ingressRequest = {
    port: opts.upstreamPort,
    path: remainingPath,
    transport: 'websocket' as const,
  };
  const upstreamPort = routeSandboxIngress(record, ingressRequest).effectivePort;

  if (!(await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId }))) {
    return { ok: false, status: 403, message: 'not authorized' };
  }
  // Both session-data ports carry the conversation — gate on session visibility,
  // not just account membership (see forwardToSandbox). This resolver forces
  // opencode WebSockets to :4096 on Daytona, so keying on 8000 alone left the
  // PTY/opencode WS leg ungated there — the same hole this PR closes on the HTTP
  // side, one function further down the file.
  if (
    requiresSessionVisibility(upstreamPort) &&
    !(await canAccessSandboxSession({
      sessionId: record.sessionId,
      projectId: record.projectId,
      accountId: record.accountId,
      userId,
      callerSessionId: callerSessionId ?? null,
      boundCredentialSessionId,
    }))
  ) {
    return {
      ok: false,
      status: 403,
      message: 'not authorized for this session',
    };
  }
  if (record.status !== 'active') {
    // A user-initiated terminal attach resumes a parked box, exactly like a
    // session mutation does on the HTTP path. Without this the socket can only
    // loop: the browser sees 1006, retries, and nothing ever wakes the sandbox.
    if (
      shouldWakeStoppedSandboxForWsAttach(record.status, remainingPath, {
        wakeRequested: opts.wakeRequested === true,
      })
    ) {
      // The resume only CLAIMS the wake: the row stays 'stopped' until the
      // provider confirms the box, which measured 16-31 s locally and ~60 s on
      // dev. Until then this returns 503 and the client dials again; a browser
      // sees each refusal as 1006 and asks `GET /kortix/pty` for the reason.
      record = await resumeAndReloadSandbox(sandboxId, record, '[preview-ws]');
    }
    if (record.status !== 'active') {
      return { ok: false, status: 503, message: `sandbox not ready (status: ${record.status})` };
    }
  }

  const ingress = await resolveSandboxIngress(record, ingressRequest);
  const previewUrl = ingress.url;
  const wsBase = previewUrl
    .replace(/\/$/, '')
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:');
  const headers = await buildSandboxUpstreamHeaders({
    sandboxId,
    userId,
    serviceKey: record.serviceKey,
    providerHeaders: ingress.headers,
  });

  const upstreamUrl = new URL(
    ingressTargetUrl({ url: wsBase, queryToken: ingress.queryToken }, remainingPath + queryString),
  );
  if (ingress.websocket?.userContextQueryParam) {
    const signedContext = headers[KORTIX_USER_CONTEXT_HEADER];
    if (signedContext) {
      upstreamUrl.searchParams.set(ingress.websocket.userContextQueryParam, signedContext);
    }
  }
  for (const [key, value] of Object.entries(ingress.websocket?.queryDefaults ?? {})) {
    if (!upstreamUrl.searchParams.has(key)) upstreamUrl.searchParams.set(key, value);
  }

  return { ok: true, url: upstreamUrl.toString(), headers };
}
