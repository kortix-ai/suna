import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import * as relayContract from '@kortix/api-contract/secret-relay';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { config } from '../../lib/config';
import {
  type PresentedHandleRefusal,
  classifyPresentedHandles,
  requestSurfaceText,
  summarizeHandleRefusals,
} from '../../secrets/handle-substitution';
import * as broker from '../../secrets/http-broker';
import { SecretBrokerError } from '../../secrets/http-broker';
import {
  type SecretRelayAuditContext,
  type SecretRelayAuthzOk,
  authorizeSecretRelay,
} from '../../secrets/relay-authorize';
import { openUpstream } from '../../secrets/relay-transport';
import type { OutboundRequestShape } from '../../secrets/strategy';
import { StreamSubstituter } from '../../secrets/stream-substitute';
import { type AuditEventInput, recordAuditEvent } from '../../shared/audit';
import {
  RELAY_CLASSIFY_PREFIX_MAX,
  RELAY_EXACT_LENGTH_MAX,
  createRelayDisposables,
  readAtMost,
  requestPairs,
  responsePairs,
  safeResponseHeaders,
  substituteStream,
  tapPrefix,
} from './relay-stream';
import { logger } from '../../lib/logger';

type RelayUpstream = Awaited<ReturnType<typeof openUpstream>>;
type RelayAuditBase = RelayHopRequest['auditBase'];

interface RelayHopRequest {
  c: Context;
  meta: relayContract.SecretRelayMeta;
  authz: SecretRelayAuthzOk;
  head: broker.PreparedRelayHead;
  upstreamBody: Readable | Buffer | null;
  bufferedBody: Buffer | null;
  bodyWasStreamed: boolean;
  requestSubstituter: StreamSubstituter;
  disposables: Set<StreamSubstituter>;
  disposeAll: () => void;
  auditBase: Omit<AuditEventInput, 'action' | 'outcome' | 'after' | 'httpStatus'>;
  refusals: PresentedHandleRefusal[];
}

interface HopState {
  hop: broker.PreparedRelayHead;
  hopUrl: string;
  hopMethod: relayContract.SecretRelayMeta['method'];
  bufferedBody: Buffer | null;
  hopBody: Readable | Buffer | null;
}

type HopFrame = RelayHopRequest & { hop: broker.PreparedRelayHead; upstream: RelayUpstream };

/** The relay's refusal envelope: the wire code rides in x-kortix-relay-error. */
export function refuse(c: Context, code: string, message: string, status: number): Response {
  c.header(relayContract.RELAY_ERROR_HEADER, code);
  c.header(relayContract.RELAY_VERSION_HEADER, String(relayContract.RELAY_VERSION));
  return c.json({ error: message, code }, status as ContentfulStatusCode);
}

export async function auditBrokerFailure(base: RelayAuditBase, error: SecretBrokerError) {
  await recordAuditEvent({
    ...base,
    action: 'secret.broker.failed',
    outcome: error.status === 403 ? 'denied' : 'failure',
    httpStatus: error.status,
    after: { reason: error.code },
  });
}

export function auditRefusals(
  base: RelayAuditBase,
  refusals: RelayHopRequest['refusals'],
  surface?: string,
) {
  return recordAuditEvent({
    ...base,
    action: 'secret.handle.refused',
    outcome: 'denied',
    after: {
      ...(surface && { surface }),
      refusals: summarizeHandleRefusals(refusals),
      detail: refusals,
    },
  });
}

/** Everything the route's own gate has already established. */
export interface RelaySessionGate {
  projectId: string;
  identifier: string;
  sessionId: string;
  userId: string;
  accountId: string;
  /** The agent token's secret-env grant, RAW — `authorizeSecretRelay`
   *  intersects it with the session allowlist itself. */
  agentGrantEnv: string[] | 'all';
}

/** The head-side context the framing passes down and the hop loop consumes. */
type RelayFrameContext = Pick<RelayHopRequest, 'meta' | 'authz' | 'head' | 'auditBase'>;

/** Everything the four framing cases touch. */
interface RelayFrameArgs extends RelayFrameContext {
  hasBody: boolean;
  declaredLength: number | null;
  rawBody: ReadableStream<Uint8Array> | null;
  primaryEncoding: broker.SecretEncoding;
  requestSubstituter: StreamSubstituter;
  disposables: RelayHopRequest['disposables'];
  disposeAll: RelayHopRequest['disposeAll'];
  classifyBodyPrefix: (prefix: Buffer) => void;
}

/** The prepared request body plus its substituter lifecycle and refusals. */
type RelayBodyFrame = Pick<
  RelayHopRequest,
  | 'upstreamBody'
  | 'bufferedBody'
  | 'bodyWasStreamed'
  | 'requestSubstituter'
  | 'disposables'
  | 'disposeAll'
  | 'refusals'
>;

/** The audit base every relay row shares: who spent which secret row, on which authorized shape. */
function relayAuditBase(
  gate: RelaySessionGate,
  shape: OutboundRequestShape,
  auditContext: SecretRelayAuditContext,
): RelayAuditBase {
  return {
    accountId: gate.accountId,
    projectId: gate.projectId,
    sessionId: gate.sessionId,
    actorUserId: gate.userId,
    actorType: 'agent' as const,
    source: 'agent',
    resourceType: 'project_secret',
    resourceId: auditContext.secretId,
    metadata: {
      identifier: gate.identifier,
      consumer: auditContext.strategy === 'egress' ? 'network' : 'http_broker',
      strategy: auditContext.strategy,
      // The one field the buffered route's audit does not carry. An operator
      // reading these rows after an incident must be able to tell which
      // transport spent the secret.
      transport: 'relay',
      host: shape.host,
      method: shape.method,
      path: shape.path,
    },
  };
}

/**
 * Turn a gated Context into the prepared hop request. Order is load-bearing
 * and unchanged from the route it was extracted from: meta → authorization →
 * audit base → head → the `secret.broker.requested` row → framing →
 * classification. A `Response` result is that refusal.
 */
export async function prepareRelayRequest(
  c: Context,
  gate: RelaySessionGate,
): Promise<Response | RelayHopRequest> {
  let meta: relayContract.SecretRelayMeta;
  try {
    meta = relayContract.decodeRelayMeta(c.req.header(relayContract.RELAY_META_HEADER) ?? '');
  } catch (error) {
    const code = error instanceof relayContract.RelayCodecError ? error.code : 'relay_meta_invalid';
    const message = error instanceof Error ? error.message : 'relay metadata is invalid';
    return refuse(c, code, message, 400);
  }

  const destination = new URL(meta.url);
  const shape = {
    host: destination.hostname,
    method: meta.method,
    path: destination.pathname,
  };

  const authz = await authorizeSecretRelay({
    projectId: gate.projectId,
    identifier: gate.identifier,
    userId: gate.userId,
    accountId: gate.accountId,
    sessionId: gate.sessionId,
    agentGrantEnv: gate.agentGrantEnv,
    shape,
  });

  const auditContext = authz.audit;
  if (!auditContext) {
    if (authz.ok) throw new Error('unreachable: an authorized relay always has an audit context');
    c.header(relayContract.RELAY_ERROR_HEADER, authz.code);
    return authz.code === 'secret_not_found'
      ? c.json({ error: authz.message }, 404)
      : c.json({ error: authz.message, code: authz.code }, 403);
  }

  const auditBase = relayAuditBase(gate, shape, auditContext);

  if (!authz.ok) {
    await recordAuditEvent({
      ...auditBase,
      action: 'secret.broker.failed',
      outcome: authz.status === 403 || authz.status === 409 ? 'denied' : 'failure',
      httpStatus: authz.status,
      after: { reason: authz.code },
    });
    return refuse(c, authz.code, authz.message, authz.status);
  }

  const head = await prepareRelayRequestHead(c, { authz, meta, auditBase });
  if (head instanceof Response) return head;

  const frame = await frameRelayRequest(c, { meta, authz, head, auditBase });
  if (frame instanceof Response) return frame;

  return { c, meta, authz, head, auditBase, ...frame };
}

/** Prepare the first hop's head, refuse the un-streamable shape, audit the request. */
async function prepareRelayRequestHead(
  c: Context,
  ctx: Pick<RelayHopRequest, 'authz' | 'meta' | 'auditBase'>,
): Promise<broker.PreparedRelayHead | Response> {
  let head: broker.PreparedRelayHead;
  try {
    head = broker.prepareRelayHead(
      ctx.authz.policy,
      ctx.authz.secret,
      { url: ctx.meta.url, method: ctx.meta.method, headers: ctx.meta.headers },
      ctx.authz.substitutions,
    );
  } catch (error) {
    const brokerError =
      error instanceof SecretBrokerError
        ? error
        : new SecretBrokerError('invalid_request', 'relay request is invalid', 400);
    await auditBrokerFailure(ctx.auditBase, brokerError);
    return refuse(c, brokerError.code, brokerError.message, brokerError.status);
  }

  // A legacy `json` body-injection slot needs the whole body parsed as JSON.
  // Streaming it is not possible without buffering unboundedly, which is the
  // cap this route exists to remove — so it is refused, by name, rather than
  // half-served. Substitution-only rows (the default since §6 of the exposure
  // model) never carry a slot.
  const bodyInjectMessage =
    'this secret uses a JSON body injection slot, which the streaming relay cannot serve; ' +
    'the buffered broker route still can';
  if (head.bodyInject) return refuse(c, 'invalid_request', bodyInjectMessage, 400);

  await recordAuditEvent({
    ...ctx.auditBase,
    action: 'secret.broker.requested',
    outcome: 'pending',
  });
  return head;
}

/**
 * Set up the request substituter and its disposal lifecycle, frame the guest's
 * body, and classify the request surface. A `Response` is the wire refusal:
 * a GET/HEAD body, or anything the framing threw.
 */
async function frameRelayRequest(
  c: Context,
  ctx: RelayFrameContext,
): Promise<RelayBodyFrame | Response> {
  // ── Framing ───────────────────────────────────────────────────────
  const hasBody = ctx.meta.body.present;
  const declaredLength = ctx.meta.body.present ? ctx.meta.body.length : null;
  if (hasBody && (ctx.meta.method === 'GET' || ctx.meta.method === 'HEAD')) {
    return refuse(c, 'invalid_request', `${ctx.meta.method} requests cannot contain a body`, 400);
  }

  const primaryEncoding = broker.bodyEncoding(ctx.head.headers['content-type']);
  const requestSubstituter = new StreamSubstituter(
    requestPairs(ctx.head.admitted, primaryEncoding),
  );

  const { disposables, disposeAll } = createRelayDisposables(requestSubstituter, c.req.raw.signal);

  /** Classify a streamed body's prefix for presented-but-refused handles. */
  const classifyBodyPrefix = (prefix: Buffer) =>
    classifyRequestBodyPrefix(prefix, ctx.authz.facts, ctx.auditBase);

  const rawBody: ReadableStream<Uint8Array> | null = c.req.raw.body ?? null;

  let framing: Pick<RelayHopRequest, 'upstreamBody' | 'bufferedBody' | 'bodyWasStreamed'>;
  try {
    framing = await frameUpstreamBody({
      ...ctx,
      hasBody,
      declaredLength,
      rawBody,
      primaryEncoding,
      requestSubstituter,
      disposables,
      disposeAll,
      classifyBodyPrefix,
    });
  } catch (error) {
    disposeAll();
    const brokerError =
      error instanceof SecretBrokerError
        ? error
        : new SecretBrokerError('invalid_request', 'relay request is invalid', 400);
    await auditBrokerFailure(ctx.auditBase, brokerError);
    return refuse(c, brokerError.code, brokerError.message, brokerError.status);
  }

  // Evidence, on the request as the guest sent it. On a streamed body the
  // classifier sees the url and the headers but not the body — a refused
  // handle past the buffered threshold is still NOT substituted (fail-closed
  // is intact) but loses its forensic line. Bounded, documented degradation.
  const surface = requestSurfaceText({
    url: ctx.meta.url,
    headers: Object.fromEntries(ctx.meta.headers),
    body: framing.bufferedBody,
  });
  const refusals = classifyPresentedHandles(surface, ctx.authz.facts, config.API_KEY_SECRET);
  if (refusals.length > 0) await auditRefusals(ctx.auditBase, refusals);

  return { ...framing, requestSubstituter, disposables, disposeAll, refusals };
}

/**
 * Classify a streamed body's prefix for presented-but-refused handles: it
 * fires when the body finishes, after the head-side classification, so it
 * writes its own audit row. Only refusals are recorded.
 */
function classifyRequestBodyPrefix(
  prefix: Buffer,
  facts: SecretRelayAuthzOk['facts'],
  auditBase: RelayAuditBase,
) {
  if (prefix.byteLength === 0) return;
  const surface = requestSurfaceText({ url: '', headers: {}, body: prefix });
  const found = classifyPresentedHandles(surface, facts, config.API_KEY_SECRET);
  if (found.length === 0) return;
  void auditRefusals(auditBase, found, 'request_body');
}

/** Pick the body's framing: none, pass-through, buffered, or streamed. */
async function frameUpstreamBody(
  args: RelayFrameArgs,
): Promise<Pick<RelayHopRequest, 'upstreamBody' | 'bufferedBody' | 'bodyWasStreamed'>> {
  const {
    head,
    hasBody,
    declaredLength,
    rawBody,
    primaryEncoding,
    requestSubstituter,
    disposables,
  } = args;
  let upstreamBody: Readable | Buffer | null = null;
  /** True when the body is gone once written — a redirect cannot replay it. */
  let bodyWasStreamed = false;
  /** The buffered body, when small enough to keep for the refusal classifier. */
  let bufferedBody: Buffer | null = null;

  if (!hasBody || !rawBody) {
    upstreamBody = null;
    requestSubstituter.dispose();
    disposables.delete(requestSubstituter);
  } else if (requestSubstituter.isPassThrough && declaredLength !== null) {
    // CASE 2 — nothing can be substituted here, so the length is PROVABLY
    // unchanged. Forward it and pipe the bytes through untouched.
    //
    // `openUpstream` honours a caller-set `content-length` on a Readable by
    // NOT adding `transfer-encoding: chunked` and by enforcing the declared
    // count in its write loop, so this promise is kept on the wire.
    head.headers['content-length'] = String(declaredLength);
    upstreamBody = Readable.fromWeb(
      rawBody.pipeThrough(tapPrefix(RELAY_CLASSIFY_PREFIX_MAX, args.classifyBodyPrefix)) as never,
    );
    bodyWasStreamed = true;
  } else if (declaredLength !== null && declaredLength <= RELAY_EXACT_LENGTH_MAX) {
    // CASE 3 — small and of known length. Buffer it (BOUNDED BY THE READ
    // ITSELF, never by the declaration), substitute with the SAME
    // whole-buffer routine the legacy path uses, and state the exact
    // post-substitution length. Byte-for-byte identical to /broker for the
    // ordinary small JSON POST, and replayable across a redirect.
    const applied = new Set<string>();
    const original = await readAtMost(rawBody, declaredLength);
    const substituted =
      head.admitted.length > 0
        ? broker.substituteBuffer(original, head.admitted, primaryEncoding, applied)
        : original;
    for (const identifier of applied) head.applied.add(identifier);
    bufferedBody = original;
    upstreamBody = substituted;
    head.headers['content-length'] = String(substituted.byteLength);
    requestSubstituter.dispose();
    disposables.delete(requestSubstituter);
  } else {
    // CASE 4 — unknown or large. Chunked, streamed through the substituter.
    //
    // This is the only chunked-hostile exposure (AWS SigV4 with a handle in
    // a >64 KiB body). It surfaces as the upstream's own 411, relayed
    // honestly. Do NOT pre-scan to compute a length — that reintroduces the
    // cap.
    // The tap runs BEFORE the substituter, so it sees the guest's ORIGINAL
    // bytes — handles intact, which is what the classifier looks for.
    upstreamBody = Readable.fromWeb(
      rawBody
        .pipeThrough(tapPrefix(RELAY_CLASSIFY_PREFIX_MAX, args.classifyBodyPrefix))
        .pipeThrough(substituteStream(requestSubstituter)) as never,
    );
    bodyWasStreamed = true;
  }

  if (head.admitted.length > 0) {
    broker.assertPolicyAdmitsPath(args.authz.policy, head.url, head.method);
  }
  return { upstreamBody, bufferedBody, bodyWasStreamed };
}

export async function runRelayHops(input: RelayHopRequest): Promise<Response> {
  const { c, meta, authz, head, upstreamBody, disposeAll, auditBase } = input;
  // Every value that could be echoed back: the route's own secret plus every
  // handle admitted on this hop.
  let redactable = [authz.secret, ...head.admitted.map((entry) => entry.value)];

  try {
    // ── The hop loop ────────────────────────────────────────────────────
    //
    // Same shape as `executeSecretBrokerRequest`'s: a redirect re-enters
    // `prepareRelayHead` against the NEW destination, so the policy, the
    // per-handle admission, the port pin and the unsafe-target check are all
    // re-run for the host we are actually about to talk to. A secret whose
    // policy admits the first host must never ride along to wherever that
    // host points next.
    const state: HopState = {
      hop: head,
      hopUrl: meta.url,
      hopMethod: meta.method,
      bufferedBody: input.bufferedBody,
      hopBody: upstreamBody,
    };

    for (let redirects = 0; ; redirects += 1) {
      const request = { url: state.hop.url, method: state.hop.method, headers: state.hop.headers };
      const upstream = await openUpstream(request, state.hopBody, { signal: c.req.raw.signal });

      if (![301, 302, 303, 307, 308].includes(upstream.status)) {
        return await buildRelayResponse({ ...input, hop: state.hop, upstream, redactable });
      }

      // ── It redirected ─────────────────────────────────────────────────
      upstream.destroy();
      const refusal = await refuseRedirect(input, state.hop);
      if (refusal) return refusal;

      const location = upstream.rawHeaders.find(([name]) => name === 'location')?.[1];
      if (!location) return refuse(c, 'upstream_failed', 'upstream redirect has no location', 502);
      if (redirects >= broker.MAX_REDIRECTS) {
        return refuse(c, 'upstream_failed', 'upstream redirect limit exceeded', 502);
      }

      const refused = await prepareRedirect(input, state, upstream);
      if (refused) return refused;
      redactable = [authz.secret, ...state.hop.admitted.map((entry) => entry.value)];
    }
  } catch (error) {
    // Anything that threw between building a substituter and handing it off
    // leaves decrypted bytes in it. Zero them here rather than waiting for GC.
    disposeAll();
    const brokerError =
      error instanceof SecretBrokerError
        ? error
        : new SecretBrokerError('upstream_failed', 'Secret relay request failed', 502);
    await auditBrokerFailure(auditBase, brokerError);
    return refuse(c, brokerError.code, brokerError.message, brokerError.status);
  }
}

async function refuseRedirect(input: RelayHopRequest, hop: broker.PreparedRelayHead) {
  const { c, requestSubstituter, bodyWasStreamed, auditBase } = input;
  const deny = async (code: SecretBrokerError['code'], message: string) => {
    await auditBrokerFailure(auditBase, new SecretBrokerError(code, message, 502));
    return refuse(c, code, message, 502);
  };
  // A redirect only matters BEFORE any real credential is on the wire.
  // Once this hop carried one, the value is already delivered and
  // following `Location` would carry it — or bytes the upstream reflected
  // into `Location` — to a host re-gated only by the ROUTE secret's
  // policy, never by the substituted secret's own. Fail closed, exactly
  // as the buffered path does.
  // `requestSubstituter.applied` is what makes this truthful on the
  // STREAMED path: `hop.applied` only ever fills on the buffered branch,
  // so without it a secret that rode out inside a streamed body left this
  // gate reading `size === 0`. It was saved by the separate
  // `bodyWasStreamed` check below — i.e. by ordering, not by the check
  // that is meant to enforce the invariant.
  if (hop.carriesSecret || hop.applied.size > 0 || requestSubstituter.applied.length > 0) {
    return deny('upstream_failed', 'redirect after secret substitution is not followed');
  }
  // No secret rode out — but the BODY may already be gone. A streamed
  // request body cannot be replayed onto the next hop, and buffering it
  // for replay would reintroduce exactly the cap this route removes. The
  // bounded ≤64 KiB path keeps its bytes, so ordinary redirects still
  // work; only a genuinely streamed body loses this.
  const notReplayable = 'the upstream redirected a streamed request body, which cannot be replayed';
  if (bodyWasStreamed) return deny('redirect_not_replayable', notReplayable);
  return null;
}

async function prepareRedirect(input: RelayHopRequest, state: HopState, upstream: RelayUpstream) {
  const { c, authz, meta, auditBase } = input;
  // Same method/body rewrite rule as the buffered path.
  if (
    upstream.status === 303 ||
    ((upstream.status === 301 || upstream.status === 302) && state.hopMethod === 'POST')
  ) {
    state.hopMethod = 'GET';
    state.bufferedBody = null;
  }
  const location = upstream.rawHeaders.find(([name]) => name === 'location')?.[1] ?? '';
  state.hopUrl = new URL(location, state.hopUrl).href;

  try {
    state.hop = broker.prepareRelayHead(
      authz.policy,
      authz.secret,
      { url: state.hopUrl, method: state.hopMethod, headers: meta.headers },
      authz.substitutions,
    );
  } catch (error) {
    const brokerError =
      error instanceof SecretBrokerError
        ? error
        : new SecretBrokerError('policy_denied', 'redirect target is not admitted', 403);
    await auditBrokerFailure(auditBase, brokerError);
    return refuse(c, brokerError.code, brokerError.message, brokerError.status);
  }
  const msg = 'this secret uses a JSON body injection slot, which the streaming relay cannot serve';
  if (state.hop.bodyInject) return refuse(c, 'invalid_request', msg, 400);

  // Re-substitute the ORIGINAL body against THIS hop's admitted set. The
  // new host can admit a handle the previous one did not, and the buffer
  // we still hold is pre-substitution precisely because nothing fired on
  // the hop before.
  if (state.bufferedBody === null) {
    state.hopBody = null;
    Reflect.deleteProperty(state.hop.headers, 'content-length');
  } else {
    const applied = new Set<string>();
    const substituted = broker.substituteBuffer(
      state.bufferedBody,
      state.hop.admitted,
      broker.bodyEncoding(state.hop.headers['content-type']),
      applied,
    );
    for (const id of applied) state.hop.applied.add(id);
    state.hopBody = substituted;
    state.hop.headers['content-length'] = String(substituted.byteLength);
  }
  if (state.hop.admitted.length > 0)
    broker.assertPolicyAdmitsPath(authz.policy, state.hop.url, state.hop.method);
}

async function auditRelayHeaders(frame: HopFrame) {
  const { hop, upstream, requestSubstituter, bodyWasStreamed, refusals, auditBase } = frame;
  // What was substituted is NOT final yet on a streamed request body —
  // the substituter is still consuming it. Record the honest superset
  // and mark it as such, so an operator never reads an EMPTY
  // `substituted` for a hop that did spend a credential. The exact set
  // lands in the terminal `secret.broker.streamed` row below.
  const streamingRequest = bodyWasStreamed && !requestSubstituter.isPassThrough;
  const substitutedSoFar = new Set([...hop.applied, ...requestSubstituter.applied]);
  const candidates = hop.admitted.map((entry) => entry.identifier).sort();
  const outcome = upstream.status >= 400 ? 'failure' : 'success';
  const after = {
    upstream_status: upstream.status,
    ...(substitutedSoFar.size > 0 && { substituted: [...substitutedSoFar].sort() }),
    ...(streamingRequest && {
      substitution: 'streamed_superset',
      substitution_candidates: candidates,
    }),
    ...(refusals.length > 0 && { handle_refusals: summarizeHandleRefusals(refusals) }),
  };
  await recordAuditEvent({ ...auditBase, action: 'secret.broker.completed', outcome, after });
}

function auditRelayCompletion(frame: HopFrame, responseBytes: number) {
  const { hop, upstream, requestSubstituter, auditBase: base } = frame;
  // The relay COMPLETED. Written here and not at header time,
  // because at header time neither the request substituter's
  // final set nor the fact of completion is known yet.
  const spent = requestSubstituter.applied.length > 0 || hop.applied.size > 0;
  const substituted = [...new Set([...hop.applied, ...requestSubstituter.applied])].sort();
  const after = {
    upstream_status: upstream.status,
    response_bytes: responseBytes,
    complete: true,
    ...(spent && { substituted }),
  };
  recordAuditEvent({ ...base, action: 'secret.broker.streamed', outcome: 'success', after }).catch((err) =>
    logger.error('[secret-relay] completion audit failed', { error: err instanceof Error ? err.message : String(err) }),
  );
}

async function buildRelayResponse(frame: HopFrame & { redactable: string[] }): Promise<Response> {
  const { meta, upstream, redactable, disposables, disposeAll } = frame;
  // ── FAIL CLOSED on a compressed body ────────────────────────────
  //
  // `prepareRelayHead` forces `accept-encoding: identity` upstream so
  // the echo scan sees plaintext. Nothing until now verified the
  // upstream OBEYED, and `content-encoding` is not in
  // SAFE_RESPONSE_HEADERS — so a gzip body would have been piped
  // through the redactor (which cannot match compressed bytes) and
  // handed to the guest as undeclared compressed data carrying the
  // real credential. Refuse instead of relaying it.
  const contentEncoding = upstream.rawHeaders
    .find(([name]) => name === 'content-encoding')?.[1]
    ?.trim()
    .toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    upstream.destroy();
    throw new SecretBrokerError(
      'upstream_encoding_unsupported',
      `upstream answered with content-encoding: ${contentEncoding} despite accept-encoding: identity, so the response cannot be scanned for an echoed secret`,
      502,
    );
  }

  const responseSubstituter = new StreamSubstituter(responsePairs(redactable));
  disposables.add(responseSubstituter);
  // `flush()` covers the clean end and is the ONLY site allowed to run
  // on it — disposing there too would zero the needles while the final
  // tail is still being substituted. The abnormal ends are what leak,
  // so hook exactly those: an upstream that dies mid-body (idle
  // timeout, byte budget, socket reset) and a guest that goes away.
  upstream.body.once('error', disposeAll);

  // The end-of-stream SENTINEL. See RELAY_EOS_BYTES: a missing chunked
  // terminator is NOT an error signal on bun 1.3.14 (measured — Bun
  // writes `0\r\n\r\n` even when the source stream is destroyed with an
  // error, and the client's fetch resolves cleanly), so truncation is
  // signalled POSITIVELY: these bytes are appended only on a clean
  // flush, and the shim treats their absence as a failed relay. Minted
  // per response and unguessable, so no truncation point can forge it.
  // Only for clients that asked — an older daemon would hand them to
  // the guest as trailing garbage.
  const eos = meta.eos === true ? randomBytes(relayContract.RELAY_EOS_BYTES) : undefined;
  const statusHeader = relayContract.encodeRelayStatus({
    v: relayContract.RELAY_VERSION,
    status: upstream.status,
    headers: safeResponseHeaders(upstream.rawHeaders, redactable),
    ...(eos && { eos: eos.toString('hex') }),
  });

  await auditRelayHeaders(frame);

  // 200 ALWAYS on success. See the status header's own docs for why the
  // upstream status is not mirrored here.
  let responseBytes = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      responseBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return new Response(
    (Readable.toWeb(upstream.body) as unknown as ReadableStream<Uint8Array>)
      .pipeThrough(counted)
      .pipeThrough(
        substituteStream(responseSubstituter, eos, () => {
          auditRelayCompletion(frame, responseBytes);
        }),
      ),
    {
      status: 200,
      headers: {
        [relayContract.RELAY_VERSION_HEADER]: String(relayContract.RELAY_VERSION),
        [relayContract.RELAY_STATUS_HEADER]: statusHeader,
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
      },
    },
  );
}
