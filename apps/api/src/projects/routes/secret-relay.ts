/**
 * `POST /v1/projects/{projectId}/secrets/{identifier}/relay` — the STREAMING
 * secret relay.
 *
 * ## Why this is a new route and not an upgrade of `/broker`
 *
 * It had to be. Measured: a `@hono/zod-openapi` route that declares a
 * `request.body` schema buffers and LOCKS the request body before the handler
 * runs (`{bodyUsed: true, bodyLocked: true}`). `/broker` validates
 * `SecretBrokerRequestSchema`, so it can never stream, however it is rewritten.
 * This route declares NO body schema at all: the body is the guest's body,
 * verbatim, and everything else rides in `x-kortix-relay-meta`.
 *
 * That is also what keeps already-deployed daemons working. `/broker` is not
 * modified, not capped differently, not deprecated. A sandbox image built today
 * can be resumed months from now and must still find its transport, so the
 * buffered route is PERMANENT.
 *
 * ## What streams and what does not
 *
 * Only the BODY streams. The url, the method and the headers arrive whole, so
 * every head-side security check runs against complete data in
 * `prepareRelayHead` — the same function the buffered route uses. This route
 * adds no policy logic of its own; it adds framing and two substituters.
 *
 * ## The one rule a reader must not lose
 *
 * `x-kortix-relay-status` PRESENT ⟺ we reached the upstream, and the payload's
 * `status` is the upstream's. ABSENT ⟺ Kortix itself refused or failed. The
 * relay's own status is therefore ALWAYS 200 on success, whatever the upstream
 * said — mirroring the upstream status would make a bare 403 ambiguous between
 * "policy denied" and "Stripe said 403", which is a distinction the agent needs.
 */
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createRoute, z } from '@hono/zod-openapi';
import {
  decodeRelayMeta,
  encodeRelayStatus,
  RELAY_EOS_BYTES,
  RELAY_ERROR_HEADER,
  RELAY_META_HEADER,
  RELAY_PROBE_HEADER,
  RELAY_STATUS_HEADER,
  RELAY_VERSION,
  RELAY_VERSION_HEADER,
  RelayCodecError,
  type SecretRelayMeta,
} from '@kortix/api-contract/secret-relay';
import { config } from '../../config';
import { getAgentGrant } from '../../iam/agent-scope';
import { auth, errors } from '../../openapi';
import {
  assertPolicyAdmitsPath,
  bodyEncoding,
  MAX_REDIRECTS,
  prepareRelayHead,
  SecretBrokerError,
  substituteBuffer,
  type PreparedRelayHead,
} from '../../secrets/http-broker';
import {
  classifyPresentedHandles,
  requestSurfaceText,
  summarizeHandleRefusals,
} from '../../secrets/handle-substitution';
import { authorizeSecretRelay } from '../../secrets/relay-authorize';
import { openUpstream } from '../../secrets/relay-transport';
import { StreamSubstituter } from '../../secrets/stream-substitute';
import {
  RELAY_CLASSIFY_PREFIX_MAX,
  RELAY_EXACT_LENGTH_MAX,
  readAtMost,
  tapPrefix,
  requestPairs,
  responsePairs,
  substituteStream,
  safeResponseHeaders,
  createRelayDisposables,
} from '../secrets/relay-stream';
import { recordAuditEvent } from '../../shared/audit';
import { loadProjectForUser } from '../lib/access';
import {
  requestEgressIp,
  verifySandboxEgressIp,
} from '../../platform/services/sandbox-egress-pin';
import { projectsApp } from '../lib/app';

/** A refusal that happened BEFORE the upstream response headers arrived. */
function refuse(c: any, code: string, message: string, status: number) {
  c.header(RELAY_ERROR_HEADER, code);
  c.header(RELAY_VERSION_HEADER, String(RELAY_VERSION));
  return c.json({ error: message, code }, status);
}

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/secrets/{identifier}/relay',
    tags: ['secrets'],
    summary: 'Stream one policy-bound HTTPS request without exposing the secret',
    description:
      'The streaming sibling of /broker. The request body is the guest body verbatim; ' +
      'url, method and headers ride in x-kortix-relay-meta. On success the response is ' +
      'always 200 and the UPSTREAM status rides in x-kortix-relay-status — the presence ' +
      'of that header is what distinguishes "Kortix refused" from "the upstream refused".',
    ...auth,
    request: {
      // NO body schema, deliberately. A zod request body buffers and LOCKS the
      // stream before this handler runs — measured — which is exactly why the
      // buffered /broker route cannot be upgraded in place.
      params: z.object({ projectId: z.string(), identifier: z.string() }),
    },
    responses: {
      200: {
        description: 'The upstream was reached. Body streams; status in x-kortix-relay-status.',
        content: { 'application/octet-stream': { schema: z.any() } },
      },
      204: { description: 'Capability probe acknowledged.' },
      ...errors(400, 403, 404, 409, 413, 502, 503, 504),
    },
  }),
  async (c: any) => {
    // The kill switch answers FIRST, so flipping it also fails the probe — which
    // is what puts every newly-constructed shim back on /broker.
    if (!config.KORTIX_SECRET_RELAY_STREAM_ENABLED) {
      return refuse(c, 'relay_disabled', 'The streaming secret relay is disabled', 503);
    }

    const projectId = c.req.param('projectId');
    const identifier = c.req.param('identifier')?.trim();
    if (!identifier) {
      return refuse(c, 'invalid_request', 'Invalid relay request', 400);
    }

    const agentGrant = getAgentGrant(c);
    const sessionId = c.get('sessionId');
    if (
      c.get('authType') !== 'pat' ||
      c.get('tokenProjectId') !== projectId ||
      !sessionId ||
      !agentGrant
    ) {
      c.header(RELAY_ERROR_HEADER, 'session_agent_token_required');
      return c.json(
        {
          error: 'Secret relay requests require a session-scoped agent token',
          code: 'session_agent_token_required',
        },
        403,
      );
    }

    // Same egress pin as /broker: this checks WHERE the token is being used
    // from, not what it is. Unpinned sessions pass — see sandbox-egress-pin.ts.
    const pin = await verifySandboxEgressIp(sessionId, requestEgressIp(c));
    if (!pin.ok) {
      console.warn('[secret-relay] refused an off-sandbox token use', {
        sessionId,
        projectId,
        pinned: pin.pinned,
        seen: pin.seen,
        enforced: config.KORTIX_SANDBOX_EGRESS_PIN_ENFORCED,
      });
    }
    if (!pin.ok && config.KORTIX_SANDBOX_EGRESS_PIN_ENFORCED) {
      c.header(RELAY_ERROR_HEADER, 'sandbox_egress_mismatch');
      return c.json(
        {
          error: 'This session credential may only be used from its own sandbox',
          code: 'sandbox_egress_mismatch',
        },
        403,
      );
    }

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    // ── Capability probe ──────────────────────────────────────────────────
    //
    // Answered here: authenticated (so it is not an unauthenticated capability
    // oracle) but BEFORE the secret is touched, so it costs one round trip per
    // daemon lifetime and reveals nothing about which secrets exist.
    if (c.req.header(RELAY_PROBE_HEADER)) {
      c.header(RELAY_VERSION_HEADER, String(RELAY_VERSION));
      return c.body(null, 204);
    }

    let meta: SecretRelayMeta;
    try {
      meta = decodeRelayMeta(c.req.header(RELAY_META_HEADER) ?? '');
    } catch (error) {
      const code = error instanceof RelayCodecError ? error.code : 'relay_meta_invalid';
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
      projectId,
      identifier,
      userId: loaded.userId,
      accountId: loaded.row.accountId,
      sessionId,
      agentGrantEnv: agentGrant.env ?? 'all',
      shape,
    });

    const auditContext = authz.audit;
    if (!auditContext) {
      if (authz.ok) throw new Error('unreachable: an authorized relay always has an audit context');
      c.header(RELAY_ERROR_HEADER, authz.code);
      return authz.code === 'secret_not_found'
        ? c.json({ error: authz.message }, 404)
        : c.json({ error: authz.message, code: authz.code }, 403);
    }

    const auditBase = {
      accountId: loaded.row.accountId,
      projectId,
      sessionId,
      actorUserId: loaded.userId,
      actorType: 'agent' as const,
      source: 'agent',
      resourceType: 'project_secret',
      resourceId: auditContext.secretId,
      metadata: {
        identifier,
        consumer: auditContext.strategy === 'egress' ? 'network' : 'http_broker',
        strategy: auditContext.strategy,
        // The one field the buffered route's audit does not carry. An operator
        // reading these rows after an incident must be able to tell which
        // transport spent the secret.
        transport: 'relay',
        host: destination.hostname,
        method: meta.method,
        path: destination.pathname,
      },
    };

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

    let head: PreparedRelayHead;
    try {
      head = prepareRelayHead(
        authz.policy,
        authz.secret,
        { url: meta.url, method: meta.method, headers: meta.headers },
        authz.substitutions,
      );
    } catch (error) {
      const brokerError =
        error instanceof SecretBrokerError
          ? error
          : new SecretBrokerError('invalid_request', 'relay request is invalid', 400);
      await recordAuditEvent({
        ...auditBase,
        action: 'secret.broker.failed',
        outcome: brokerError.status === 403 ? 'denied' : 'failure',
        httpStatus: brokerError.status,
        after: { reason: brokerError.code },
      });
      return refuse(c, brokerError.code, brokerError.message, brokerError.status);
    }

    // A legacy `json` body-injection slot needs the whole body parsed as JSON.
    // Streaming it is not possible without buffering unboundedly, which is the
    // cap this route exists to remove — so it is refused, by name, rather than
    // half-served. Substitution-only rows (the default since §6 of the exposure
    // model) never carry a slot.
    if (head.bodyInject) {
      return refuse(
        c,
        'invalid_request',
        'this secret uses a JSON body injection slot, which the streaming relay cannot serve; ' +
          'the buffered broker route still can',
        400,
      );
    }

    await recordAuditEvent({ ...auditBase, action: 'secret.broker.requested', outcome: 'pending' });

    // ── Framing ───────────────────────────────────────────────────────────
    const hasBody = meta.body.present;
    const declaredLength = meta.body.present ? meta.body.length : null;
    if (hasBody && (meta.method === 'GET' || meta.method === 'HEAD')) {
      return refuse(c, 'invalid_request', `${meta.method} requests cannot contain a body`, 400);
    }

    const primaryEncoding = bodyEncoding(head.headers['content-type']);
    const requestSubstituter = new StreamSubstituter(
      requestPairs(head.admitted, primaryEncoding),
    );

    const { disposables, disposeAll } = createRelayDisposables(requestSubstituter, c.req.raw.signal);

    /**
     * Classify a streamed body's prefix for presented-but-refused handles.
     *
     * Fires when the request body finishes, which is after the head-side
     * classification below — so it writes its own audit row rather than
     * amending one. Only refusals are recorded; a handle that WAS admitted is
     * an ordinary substitution and already audited as such.
     */
    const classifyBodyPrefix = (prefix: Buffer) => {
      if (prefix.byteLength === 0) return;
      const found = classifyPresentedHandles(
        requestSurfaceText({ url: '', headers: {}, body: prefix }),
        authz.facts,
        config.API_KEY_SECRET,
      );
      if (found.length === 0) return;
      void recordAuditEvent({
        ...auditBase,
        action: 'secret.handle.refused',
        outcome: 'denied',
        after: {
          surface: 'request_body',
          refusals: summarizeHandleRefusals(found),
          detail: found,
        },
      });
    };

    let upstreamBody: Readable | Buffer | null = null;
    /** True when the body is gone once written — a redirect cannot replay it. */
    let bodyWasStreamed = false;
    /** The buffered body, when small enough to keep for the refusal classifier. */
    let bufferedBody: Buffer | null = null;

    const rawBody: ReadableStream<Uint8Array> | null = c.req.raw.body ?? null;

    try {
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
          rawBody.pipeThrough(tapPrefix(RELAY_CLASSIFY_PREFIX_MAX, classifyBodyPrefix)) as never,
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
            ? substituteBuffer(original, head.admitted, primaryEncoding, applied)
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
            .pipeThrough(tapPrefix(RELAY_CLASSIFY_PREFIX_MAX, classifyBodyPrefix))
            .pipeThrough(substituteStream(requestSubstituter)) as never,
        );
        bodyWasStreamed = true;
      }

      if (head.admitted.length > 0) {
        assertPolicyAdmitsPath(authz.policy, head.url, head.method);
      }
    } catch (error) {
      disposeAll();
      const brokerError =
        error instanceof SecretBrokerError
          ? error
          : new SecretBrokerError('invalid_request', 'relay request is invalid', 400);
      await recordAuditEvent({
        ...auditBase,
        action: 'secret.broker.failed',
        outcome: brokerError.status === 403 ? 'denied' : 'failure',
        httpStatus: brokerError.status,
        after: { reason: brokerError.code },
      });
      return refuse(c, brokerError.code, brokerError.message, brokerError.status);
    }

    // Evidence, on the request as the guest sent it. On a streamed body the
    // classifier sees the url and the headers but not the body — a refused
    // handle past the buffered threshold is still NOT substituted (fail-closed
    // is intact) but loses its forensic line. Bounded, documented degradation.
    const refusals = classifyPresentedHandles(
      requestSurfaceText({
        url: meta.url,
        headers: Object.fromEntries(meta.headers),
        body: bufferedBody,
      }),
      authz.facts,
      config.API_KEY_SECRET,
    );
    if (refusals.length > 0) {
      await recordAuditEvent({
        ...auditBase,
        action: 'secret.handle.refused',
        outcome: 'denied',
        after: { refusals: summarizeHandleRefusals(refusals), detail: refusals },
      });
    }

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
      let hop = head;
      let hopUrl = meta.url;
      let hopMethod: typeof meta.method = meta.method;
      let hopBody = upstreamBody;

      for (let redirects = 0; ; redirects += 1) {
        const upstream = await openUpstream(
          { url: hop.url, method: hop.method, headers: hop.headers },
          hopBody,
          { signal: c.req.raw.signal },
        );

        if (![301, 302, 303, 307, 308].includes(upstream.status)) {
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
              `upstream answered with content-encoding: ${contentEncoding} despite accept-encoding: identity, ` +
                'so the response cannot be scanned for an echoed secret',
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
          const eos = meta.eos === true ? randomBytes(RELAY_EOS_BYTES) : undefined;

          const statusHeader = encodeRelayStatus({
            v: RELAY_VERSION,
            status: upstream.status,
            headers: safeResponseHeaders(upstream.rawHeaders, redactable),
            ...(eos ? { eos: eos.toString('hex') } : {}),
          });

          // What was substituted is NOT final yet on a streamed request body —
          // the substituter is still consuming it. Record the honest superset
          // and mark it as such, so an operator never reads an EMPTY
          // `substituted` for a hop that did spend a credential. The exact set
          // lands in the terminal `secret.broker.streamed` row below.
          const streamingRequest = bodyWasStreamed && !requestSubstituter.isPassThrough;
          const substitutedSoFar = new Set([...hop.applied, ...requestSubstituter.applied]);
          await recordAuditEvent({
            ...auditBase,
            action: 'secret.broker.completed',
            outcome: upstream.status >= 400 ? 'failure' : 'success',
            after: {
              upstream_status: upstream.status,
              ...(substitutedSoFar.size > 0
                ? { substituted: [...substitutedSoFar].sort() }
                : {}),
              ...(streamingRequest
                ? {
                    substitution: 'streamed_superset',
                    substitution_candidates: hop.admitted
                      .map((entry) => entry.identifier)
                      .sort(),
                  }
                : {}),
              ...(refusals.length > 0
                ? { handle_refusals: summarizeHandleRefusals(refusals) }
                : {}),
            },
          });

          // 200 ALWAYS on success. See the status header's own docs for why the
          // upstream status is not mirrored here.
          let responseBytes = 0;
          return new Response(
            (Readable.toWeb(upstream.body) as unknown as ReadableStream<Uint8Array>)
              .pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, controller) {
                    responseBytes += chunk.byteLength;
                    controller.enqueue(chunk);
                  },
                }),
              )
              .pipeThrough(
                substituteStream(responseSubstituter, eos, () => {
                  // The relay COMPLETED. Written here and not at header time,
                  // because at header time neither the request substituter's
                  // final set nor the fact of completion is known yet.
                  void recordAuditEvent({
                    ...auditBase,
                    action: 'secret.broker.streamed',
                    outcome: 'success',
                    after: {
                      upstream_status: upstream.status,
                      response_bytes: responseBytes,
                      complete: true,
                      ...(requestSubstituter.applied.length > 0 || hop.applied.size > 0
                        ? {
                            substituted: [
                              ...new Set([...hop.applied, ...requestSubstituter.applied]),
                            ].sort(),
                          }
                        : {}),
                    },
                  });
                }),
              ),
            {
              status: 200,
              headers: {
                [RELAY_VERSION_HEADER]: String(RELAY_VERSION),
                [RELAY_STATUS_HEADER]: statusHeader,
                'content-type': 'application/octet-stream',
                'cache-control': 'no-store',
              },
            },
          );
        }

        // ── It redirected ─────────────────────────────────────────────────
        upstream.destroy();

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
        if (
          hop.carriesSecret ||
          hop.applied.size > 0 ||
          requestSubstituter.applied.length > 0
        ) {
          await recordAuditEvent({
            ...auditBase,
            action: 'secret.broker.failed',
            outcome: 'failure',
            httpStatus: 502,
            after: { reason: 'upstream_failed' },
          });
          return refuse(
            c,
            'upstream_failed',
            'redirect after secret substitution is not followed',
            502,
          );
        }

        // No secret rode out — but the BODY may already be gone. A streamed
        // request body cannot be replayed onto the next hop, and buffering it
        // for replay would reintroduce exactly the cap this route removes. The
        // bounded ≤64 KiB path keeps its bytes, so ordinary redirects still
        // work; only a genuinely streamed body loses this.
        if (bodyWasStreamed) {
          await recordAuditEvent({
            ...auditBase,
            action: 'secret.broker.failed',
            outcome: 'failure',
            httpStatus: 502,
            after: { reason: 'redirect_not_replayable' },
          });
          return refuse(
            c,
            'redirect_not_replayable',
            'the upstream redirected a streamed request body, which cannot be replayed',
            502,
          );
        }

        const location = upstream.rawHeaders.find(([name]) => name === 'location')?.[1];
        if (!location) {
          return refuse(c, 'upstream_failed', 'upstream redirect has no location', 502);
        }
        if (redirects >= MAX_REDIRECTS) {
          return refuse(c, 'upstream_failed', 'upstream redirect limit exceeded', 502);
        }

        // Same method/body rewrite rule as the buffered path.
        const nextUrl = new URL(location, hopUrl).href;
        if (
          upstream.status === 303 ||
          ((upstream.status === 301 || upstream.status === 302) && hopMethod === 'POST')
        ) {
          hopMethod = 'GET';
          bufferedBody = null;
        }
        hopUrl = nextUrl;

        try {
          hop = prepareRelayHead(
            authz.policy,
            authz.secret,
            { url: hopUrl, method: hopMethod, headers: meta.headers },
            authz.substitutions,
          );
        } catch (error) {
          const brokerError =
            error instanceof SecretBrokerError
              ? error
              : new SecretBrokerError('policy_denied', 'redirect target is not admitted', 403);
          await recordAuditEvent({
            ...auditBase,
            action: 'secret.broker.failed',
            outcome: brokerError.status === 403 ? 'denied' : 'failure',
            httpStatus: brokerError.status,
            after: { reason: brokerError.code },
          });
          return refuse(c, brokerError.code, brokerError.message, brokerError.status);
        }
        if (hop.bodyInject) {
          return refuse(
            c,
            'invalid_request',
            'this secret uses a JSON body injection slot, which the streaming relay cannot serve',
            400,
          );
        }

        // Re-substitute the ORIGINAL body against THIS hop's admitted set. The
        // new host can admit a handle the previous one did not, and the buffer
        // we still hold is pre-substitution precisely because nothing fired on
        // the hop before.
        if (bufferedBody === null) {
          hopBody = null;
          delete hop.headers['content-length'];
        } else {
          const applied = new Set<string>();
          const substituted =
            hop.admitted.length > 0
              ? substituteBuffer(
                  bufferedBody,
                  hop.admitted,
                  bodyEncoding(hop.headers['content-type']),
                  applied,
                )
              : bufferedBody;
          for (const id of applied) hop.applied.add(id);
          hopBody = substituted;
          hop.headers['content-length'] = String(substituted.byteLength);
        }
        if (hop.admitted.length > 0) assertPolicyAdmitsPath(authz.policy, hop.url, hop.method);
        redactable = [authz.secret, ...hop.admitted.map((entry) => entry.value)];
      }
    } catch (error) {
      // Anything that threw between building a substituter and handing it off
      // leaves decrypted bytes in it. Zero them here rather than waiting for GC.
      disposeAll();
      const brokerError =
        error instanceof SecretBrokerError
          ? error
          : new SecretBrokerError('upstream_failed', 'Secret relay request failed', 502);
      await recordAuditEvent({
        ...auditBase,
        action: 'secret.broker.failed',
        outcome: brokerError.status === 403 ? 'denied' : 'failure',
        httpStatus: brokerError.status,
        after: { reason: brokerError.code },
      });
      return refuse(c, brokerError.code, brokerError.message, brokerError.status);
    }
  },
);
