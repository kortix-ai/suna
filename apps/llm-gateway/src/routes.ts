import {
  gatewayErrorResponse, gatewayOverloadedResponse, readAdmittedBody,
  releaseWhenResponseEnds, requestTooLargeResponse, type InflightBudget,
} from '@kortix/llm-gateway';
import type { Hono } from 'hono';
import { cloudflareSafe, messagesAuthorization, perRequestCapBytes } from './server';

type Protocol = 'chat' | 'messages' | 'responses';
type Gateway = {
  chatCompletions: (request: { authorization: string | undefined; rawBody: string; signal?: AbortSignal }) => Promise<Response>;
  messages: (request: { authorization: string | undefined; rawBody: string; signal?: AbortSignal }) => Promise<Response>;
  responses: (request: { authorization: string | undefined; rawBody: string; signal?: AbortSignal }) => Promise<Response>;
  listModels: (authorization: string | undefined, options: { managedOnly: boolean; scope?: 'picker' }) => Promise<Response>;
};

function failure(protocol: Protocol, requestId: string): Response {
  if (protocol === 'chat') return gatewayErrorResponse(503, {
    message: 'Gateway unavailable', code: 'gateway_error', provider: '', requestedModel: '',
    resolvedModel: '', requestId,
    suggestion: 'Retry the request. If the error continues, switch to another model.',
  });
  return new Response(JSON.stringify(protocol === 'messages'
    ? { type: 'error', error: { type: 'api_error', message: 'Gateway unavailable' } }
    : { error: { type: 'server_error', message: 'Gateway unavailable', code: null, param: null } }),
    { status: 503, headers: { 'content-type': 'application/json' } });
}

function inference(gateway: Gateway, inflight: InflightBudget, recordOutcome: (status: number) => void, protocol: Protocol) {
  return async (c: { req: { raw: Request; header: (name: string) => string | undefined } }) => {
    const requestId = protocol === 'chat' ? `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}` : '';
    try {
      // Reserve capacity before the body is materialized. `c.req.raw` is the
      // standard Request: admission needs it, and its `signal` drives the
      // client-disconnect abort below.
      const body = await readAdmittedBody(c.req.raw, perRequestCapBytes, inflight);
      if (!body.ok) {
        const status = body.reason === 'too_large' ? 413 : 503;
        if (protocol === 'chat' && body.reason === 'overloaded') console.warn('[gateway] admission overloaded', {
          usedBytes: inflight.inflightBytes, capacityBytes: inflight.capacityBytes, utilization: inflight.utilisation,
        });
        // A client that vanished mid-upload is not a fleet error: its
        // reservation is already back and nobody reads this response. Keeping
        // it out of the error rate stops an aborting client from faking an
        // incident on /health.
        if (body.reason !== 'client_aborted') recordOutcome(status);
        return status === 413 ? requestTooLargeResponse(requestId || undefined)
          : gatewayOverloadedResponse(body.retryAfterSeconds ?? 1, requestId || undefined);
      }
      try {
        const request = {
          authorization: protocol === 'messages'
            ? messagesAuthorization(c.req.header('authorization'), c.req.header('x-api-key'))
            : c.req.header('authorization'),
          // `signal` fires on client disconnect, so a caller that goes away
          // mid-request stops the upstream fetch/stream. Without it a
          // disconnected client left the provider generating, and billing, a
          // turn nobody would read.
          rawBody: body.body, signal: c.req.raw?.signal,
        };
        body.body = '';
        const res = await cloudflareSafe(await gateway[protocol === 'chat' ? 'chatCompletions' : protocol](request));
        recordOutcome(res.status);
        return releaseWhenResponseEnds(res, body.release);
      } catch (error) {
        body.release();
        throw error;
      }
    } catch (error) {
      console.error(protocol === 'chat' ? '[gateway] request failed' : `[gateway] ${protocol} request failed`, error);
      recordOutcome(503);
      return failure(protocol, requestId);
    }
  };
}

/**
 * Every inference route under four alias prefixes. The API reverse proxy
 * exposes `/v1/llm-gateway` as the OpenAI base URL and strips that prefix, so
 * OpenAI-compatible clients reach this service at `/chat/completions`.
 * `messages` is the Anthropic Messages shape and `responses` the OpenAI
 * Responses shape (Codex CLI >=0.157 speaks only `wire_api = "responses"`).
 * Both translate at the edges only: auth, grants, routing, dispatch, metering
 * and audit run through the same pipeline as chat completions.
 * `models?scope=managed` → managed lineup only (~3KB); `?scope=picker` → the
 * project's servable set (~80KB), fetched by sandboxes on every boot so their
 * `kortix` provider matches the web picker. See wire.ts.
 */
export function registerRoutes(app: Hono, gateway: Gateway, inflight: InflightBudget, recordOutcome: (status: number) => void) {
  const chat = inference(gateway, inflight, recordOutcome, 'chat');
  const messages = inference(gateway, inflight, recordOutcome, 'messages');
  const responses = inference(gateway, inflight, recordOutcome, 'responses');
  for (const prefix of ['/', '/v1/', '/v1/llm/', '/v1/openai/']) {
    app.post(prefix + 'chat/completions', chat);
    app.post(prefix + 'messages', messages);
    app.post(prefix + 'responses', responses);
    app.get(prefix + 'models', (c) => gateway.listModels(c.req.header('authorization'), {
      managedOnly: c.req.query('scope') === 'managed',
      scope: c.req.query('scope') === 'picker' ? 'picker' : undefined,
    }).then(cloudflareSafe));
  }
}
