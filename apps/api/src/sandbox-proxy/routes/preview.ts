import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { isSandboxAuthored } from '../../projects/sandbox-deadline';
import { takePrefetchedSandbox } from '../http-prefetch';
import { jsonProxyError } from '../pre-prompt-env-sync';
import { forwardToSandbox } from '../forward';

// `userId` is set by combinedAuth (mounted in ../index.ts) before this route.
// `apiKeyType` is read to decide whether a request may extend the sandbox's
// deadline: a box holds a credential that authenticates perfectly well, and a
// request it authors itself must never be able to prolong its own life.
const preview = new Hono<{
  Variables: {
    userId: string;
    userEmail: string;
    sessionId?: string;
    apiKeyType?: 'user' | 'sandbox';
  };
}>();

// The forwarder (wake, access, upstream hop, retry loop) lives in ../forward/.
// Re-exported so existing import paths, and the suites that read these names
// off `./preview` or `mock.module` this path, keep working.
export {
  bindSandboxRequestContext,
  forwardToSandbox,
  forwardsClientEncoding,
  isProxiedBaseReset,
  resolvePreviewWsUpstream,
  shouldAutoResumeStoppedSandbox,
  shouldWakeStoppedSandboxForWsAttach,
} from '../forward';

// The response/header helpers moved to ../preview-response.ts (KRTX-326 phase 2).
export * from '../preview-response';

// The largest body the proxy will accept, matching Bun's own default socket
// ceiling (128 MiB). Declared here so the limit is a stated number the client is
// told about, rather than an implicit runtime default it discovers by failing.
export const MAX_PROXY_BODY_BYTES = 128 * 1024 * 1024;

// === Route handlers: ALL /:sandboxId/:port(/*) ===
//
// Thin wrappers around forwardToSandbox — extract params from the Hono context.

preview.all('/:sandboxId/:port/*', async (c) => {
  const sandboxId = c.req.param('sandboxId');
  const portStr = c.req.param('port');
  const port = Number.parseInt(portStr, 10);

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new HTTPException(400, { message: `Invalid port: ${portStr}` });
  }

  const userId = c.get('userId') as string;

  const method = c.req.method;

  // Refuse an over-large body BEFORE reading it, and say so in a response the
  // client can actually read.
  //
  // Neither Bun.serve call sets `maxRequestBodySize`, so the effective ceiling is
  // Bun's 128 MiB default, enforced at the SOCKET. That returns a bare 413 with
  // an EMPTY body and no CORS headers, so a cross-origin browser upload surfaces
  // as an opaque network/CORS failure rather than "your file is too big", and the
  // SDK can only render `Upload failed (413): Request Entity Too Large` — no
  // filename, no stated limit. Checking Content-Length here gets in front of the
  // socket and returns a real JSON body through `jsonProxyError`, which attaches
  // the CORS headers every other proxy response carries.
  //
  // Content-Length is client-supplied and absent on a chunked body, so this is
  // the friendly path, not the enforcement boundary. The socket limit remains the
  // hard stop.
  const contentLength = Number(c.req.header('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_BODY_BYTES) {
    return jsonProxyError(
      {
        error: `Request body is ${Math.round(contentLength / 1_048_576)} MB, over the ${Math.round(MAX_PROXY_BODY_BYTES / 1_048_576)} MB limit.`,
        message: `Request body is ${Math.round(contentLength / 1_048_576)} MB, over the ${Math.round(MAX_PROXY_BODY_BYTES / 1_048_576)} MB limit.`,
        code: 'UPLOAD_TOO_LARGE',
        max_bytes: MAX_PROXY_BODY_BYTES,
        received_bytes: contentLength,
      },
      413,
      c.req.header('Origin') || '',
    );
  }

  let body: ArrayBuffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await c.req.raw.clone().arrayBuffer();
  }

  const fullPath = new URL(c.req.url).pathname;
  const prefixPattern = `/${sandboxId}/${portStr}`;
  const prefixIndex = fullPath.indexOf(prefixPattern);
  const remainingPath =
    prefixIndex !== -1 ? fullPath.slice(prefixIndex + prefixPattern.length) || '/' : '/';
  const upstreamUrl = new URL(c.req.url);
  upstreamUrl.searchParams.delete('token');
  const queryString = upstreamUrl.search;

  const origin = c.req.header('Origin') || '';

  // Public origin the client used. Prefer X-Forwarded-Proto (TLS-terminating LB
  // in prod), else the scheme the request actually arrived on — never assume
  // https, which breaks the static-web <base> tag over http in local dev.
  const proto = c.req.header('x-forwarded-proto') || upstreamUrl.protocol.replace(':', '');
  const host = c.req.header('host') || upstreamUrl.host;
  const publicOrigin = `${proto}://${host}`;

  return forwardToSandbox(
    sandboxId,
    port,
    {
      kind: 'principal',
      userId,
      callerSessionId: c.get('sessionId') ?? null,
      // The manager-override gate needs the AGENT binding, so it reads the
      // helper — same reason `sandboxAuthored` below does. The raw context var
      // is the SUPABASE login session id for a human on the network-fallback
      // branch, which would strip managers of the override.
      boundCredentialSessionId: callerKortixSessionId(c),
      // `callerKortixSessionId`, NEVER the raw context var. `combinedAuth`'s
      // local JWT fast path leaves `sessionId` unset for a browser, but its
      // NETWORK-FALLBACK branch (taken whenever JWKS has not warmed, and
      // permanently if JWKS resolution is broken) sets it to the SUPABASE AUTH
      // SESSION id. Reading it raw made every human in that window look
      // sandbox-authored: no turn-start extend, no preview-use extend, and no
      // auto-resume of a parked box from the UI.
      sandboxAuthored: isSandboxAuthored(c.get('apiKeyType'), callerKortixSessionId(c)),
      // A person (JWT or personal token) starting a turn here: neither the
      // sandbox key nor a credential bound to an agent session.
      bindTurnIdentity: !isSandboxAuthored(c.get('apiKeyType'), callerKortixSessionId(c)),
    },
    method,
    remainingPath,
    queryString,
    c.req.raw.headers,
    body,
    origin,
    undefined, // redirectPrefix → default `/v1/p/{sandbox}/{port}`
    publicOrigin,
    // The row the proxy app started reading while auth ran (index.ts).
    { record: await takePrefetchedSandbox(c, sandboxId) },
  );
});

export { preview };
