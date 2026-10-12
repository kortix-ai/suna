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
 * adds no policy logic of its own: authorization, framing, substitution and
 * the hop loop all live in the relay engine (`projects/secrets/http-relay-hop.ts`),
 * which this file calls once per request.
 *
 * ## The one rule a reader must not lose
 *
 * `x-kortix-relay-status` PRESENT ⟺ we reached the upstream, and the payload's
 * `status` is the upstream's. ABSENT ⟺ Kortix itself refused or failed. The
 * relay's own status is therefore ALWAYS 200 on success, whatever the upstream
 * said — mirroring the upstream status would make a bare 403 ambiguous between
 * "policy denied" and "Stripe said 403", which is a distinction the agent needs.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  RELAY_ERROR_HEADER,
  RELAY_PROBE_HEADER,
  RELAY_VERSION,
  RELAY_VERSION_HEADER,
} from '@kortix/api-contract/secret-relay';
import { config } from '../../config';
import { getAgentGrant } from '../../iam/agent-scope';
import { auth, errors } from '../../openapi';
import { requestEgressIp, verifySandboxEgressIp } from '../../platform/services/sandbox-egress-pin';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { prepareRelayRequest, refuse, runRelayHops } from '../secrets/http-relay-hop';

export function registerSecretRelayRoutes(): void {
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

      // The gate above is everything this route owns; the rest is the relay engine.
      const prepared = await prepareRelayRequest(c, {
        projectId,
        identifier,
        sessionId,
        userId: loaded.userId,
        accountId: loaded.row.accountId,
        agentGrantEnv: agentGrant.env ?? 'all',
      });
      if (prepared instanceof Response) return prepared;
      return runRelayHops(prepared);
    },
  );
}
