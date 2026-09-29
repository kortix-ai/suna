import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import * as relayContract from '@kortix/api-contract/secret-relay';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  type PresentedHandleRefusal,
  summarizeHandleRefusals,
} from '../../secrets/handle-substitution';
import * as broker from '../../secrets/http-broker';
import { SecretBrokerError } from '../../secrets/http-broker';
import type { SecretRelayAuthzOk } from '../../secrets/relay-authorize';
import { openUpstream } from '../../secrets/relay-transport';
import { StreamSubstituter } from '../../secrets/stream-substitute';
import { type AuditEventInput, recordAuditEvent } from '../../shared/audit';
import { responsePairs, safeResponseHeaders, substituteStream } from './relay-stream';

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
  void recordAuditEvent({ ...base, action: 'secret.broker.streamed', outcome: 'success', after });
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
