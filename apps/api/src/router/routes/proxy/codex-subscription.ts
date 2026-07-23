import { HTTPException } from 'hono/http-exception';
import { CodexRefreshError, resolveCodexCredential } from '../../../llm-gateway/credentials/codex';
import { codexDescriptor } from '../../../llm-gateway/resolution/descriptors';
import { validateAccountToken } from '../../../repositories/account-tokens';
import { getRequestBody } from './helpers';

// === Codex/ChatGPT SUBSCRIPTION proxy ===
//
// Deliberately NOT part of the generic `services` catch-all in ./routes.ts
// (handlers.ts's handleKortixProxy / Mode 1). That path always injects
// KORTIX'S OWN OPENAI_API_KEY/OPENROUTER_API_KEY and bills the caller's
// Kortix credit wallet at KORTIX_MARKUP (1.2x) — correct for a Kortix-managed
// model, but WRONG for a Codex ACP session authenticated with a user's own
// connected ChatGPT/Codex subscription: that path bypassed the subscription
// entirely, paid OpenAI with Kortix's key, and STILL billed the user Kortix
// credits. See docs/specs/2026-07-21-codex-billing-leak-verification.md for
// the full trace and apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts
// (the `codex_subscription` branch of resolveAcpHarnessLaunchEnv), which is
// the only launch path that points a session at this route.
//
// This route instead:
//   - only accepts a `kortix_pat_…` account token (validateAccountToken) that
//     carries the launching user's own projectId/userId — never a bare
//     `kortix_sb_…` sandbox token (isKortixToken/Mode 1's token shape). A
//     sandbox token fails validateAccountToken outright, so the generic
//     Kortix-managed-key path can never be reached from here, by construction;
//   - resolves the CALLER's OWN Codex OAuth credential via
//     resolveCodexCredential — the SAME resolver (+ refresh logic) the modern
//     @kortix/llm-gateway `codex/*` model path already uses
//     (apps/api/src/llm-gateway/resolution/resolve-candidates.ts) — and
//     forwards with THAT access token, never Kortix's own
//     OPENAI_API_KEY/OPENROUTER_API_KEY;
//   - never touches Kortix credit billing (no deductLLMCredits /
//     reserveEstimatedLlmCredits call anywhere in this file) — usage is
//     covered by the user's own ChatGPT/Codex subscription, matching
//     codexDescriptor's `billingMode: 'none'` contract for the identical
//     reason the llm-gateway path already treats it as $0 Kortix-metered;
//   - fails closed (401/502) on a missing, expired, or unresolvable
//     credential — it must NEVER fall back to the Kortix-managed key. A
//     silent fallback there is exactly the bug this route exists to close.
//
// The resolved OAuth access token never leaves this server: it is decrypted
// from the project's encrypted secret, refreshed here if needed, used only
// for the single outbound fetch below, and never echoed back to the caller
// in any response header or body.

const CODEX_RESPONSES_PATH = '/responses';

// Header names from the inbound codex-acp request that are part of the
// legitimate Codex Responses-API wire protocol (see codex-rs's
// `build_responses_headers`/`build_session_headers` and the JS adapter's
// `applyGatewayConfig`, which always merges in `X-Client-Feature-ID`) and are
// therefore safe — and in some cases required — to forward verbatim to
// chatgpt.com. Deliberately an ALLOWLIST, not a blocklist: this route's
// caller reaches us through a Cloudflare Tunnel (trycloudflare.com), which
// injects proxy-hop headers (`cf-connecting-ip`, `cf-ray`, `cf-ipcountry`,
// `cf-visitor`, `cdn-loop`, `x-forwarded-for`, `x-forwarded-proto`, …) on
// EVERY inbound request. chatgpt.com/backend-api is itself Cloudflare-fronted;
// forwarding a client-supplied `cf-connecting-ip` (or the other cf-*/XFF
// headers) to it is indistinguishable from IP-spoofing and its edge WAF
// blocks the request outright with a 403 HTML challenge page — proven live
// 2026-07-21 against the real chatgpt.com/backend-api/codex endpoint with a
// real resolved credential: the exact header set this function now sends
// gets a normal 400 JSON response from the model backend, while adding back
// a single synthetic `cf-connecting-ip` header reproduces the reported 403
// HTML block page byte-for-byte (same cf-ray-bearing Cloudflare page shape).
// A blocklist would only ever catch cf-* headers we already know about; new
// proxy infra in front of this route (or a future trycloudflare.com header)
// would silently reopen the same 403. Only what Codex's own wire protocol
// actually uses is forwarded; everything else — including any Kortix/tunnel/
// CDN header, known or not — is dropped by construction.
const FORWARDABLE_HEADER_NAMES = new Set([
  'accept',
  'accept-encoding',
  'content-type',
  'session-id',
  'thread-id',
  'x-client-request-id',
  'x-client-feature-id',
  'x-codex-beta-features',
  'x-codex-turn-state',
  'x-openai-subagent',
]);

function buildCodexUpstreamHeaders(
  c: any,
  descriptor: ReturnType<typeof codexDescriptor>,
): Headers {
  const headers = new Headers();
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (FORWARDABLE_HEADER_NAMES.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  if (!headers.has('content-type')) headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Bearer ${descriptor.apiKey}`);
  for (const [key, value] of Object.entries(descriptor.headers ?? {})) {
    headers.set(key, value);
  }
  return headers;
}

export async function handleCodexSubscriptionProxy(c: any) {
  const authHeader = c.req.header('Authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  if (!bearerToken) {
    throw new HTTPException(401, { message: 'Missing bearer token' });
  }

  // validateAccountToken only accepts the `kortix_pat_…` shape — a
  // `kortix_sb_…` sandbox token (isKortixToken's Mode 1 shape) is rejected
  // here (isValid: false), never silently treated as an account token.
  const auth = await validateAccountToken(bearerToken);
  if (!auth.isValid || !auth.userId || !auth.projectId) {
    throw new HTTPException(401, {
      message: 'Codex subscription proxy requires a project-scoped Kortix account token',
    });
  }

  const fullPath = new URL(c.req.url).pathname;
  const prefixIdx = fullPath.indexOf('/codex-subscription');
  const subPath =
    prefixIdx !== -1 ? fullPath.slice(prefixIdx + '/codex-subscription'.length) || '/' : '/';
  const method = c.req.method;
  if (method !== 'POST' || subPath.split('?')[0] !== CODEX_RESPONSES_PATH) {
    throw new HTTPException(403, { message: `Route not available: ${method} ${subPath}` });
  }

  let credential: Awaited<ReturnType<typeof resolveCodexCredential>>;
  try {
    credential = await resolveCodexCredential(auth.projectId, auth.userId);
  } catch (err) {
    if (err instanceof CodexRefreshError) {
      throw new HTTPException(401, {
        message:
          'Your Codex session has expired or was revoked. Reconnect Codex in project settings.',
      });
    }
    throw new HTTPException(502, {
      message: `Failed to resolve Codex credential: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!credential) {
    throw new HTTPException(401, {
      message: 'No Codex/ChatGPT subscription is connected for this project.',
    });
  }

  // Reuse the exact same descriptor the llm-gateway `codex/*` model path
  // builds (apps/api/src/llm-gateway/resolution/descriptors.ts) — one place
  // owns "what baseUrl/headers a resolved Codex credential talks to", not two.
  const descriptor = codexDescriptor(credential, 'codex/unused');

  const queryString = new URL(c.req.url).search;
  const targetUrl = `${descriptor.baseUrl}${CODEX_RESPONSES_PATH}${queryString}`;

  // Deliberately NOT buildForwardHeaders(c) (used elsewhere in this proxy
  // package): that copies every inbound header through, including whatever
  // the trycloudflare.com Cloudflare Tunnel injects on this hop
  // (cf-connecting-ip, cf-ray, cdn-loop, x-forwarded-for, …). Forwarded to
  // the also-Cloudflare-fronted chatgpt.com, those read as IP-spoofing and
  // get the request 403'd by its edge WAF before it ever reaches the model
  // backend — see buildCodexUpstreamHeaders' comment for the live repro.
  const headers = buildCodexUpstreamHeaders(c, descriptor);

  const body = await getRequestBody(c, method);

  console.log(
    `[PROXY] codex-subscription (project:${auth.projectId}) ${method} ${CODEX_RESPONSES_PATH} → ${targetUrl} [no Kortix billing — user's own subscription]`,
  );

  const upstream = await fetch(targetUrl, {
    method,
    headers,
    body,
    // @ts-ignore
    duplex: 'half',
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
