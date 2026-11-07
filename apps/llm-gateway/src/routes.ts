import {
  readRequestOrigin,
  gatewayErrorResponse, gatewayOverloadedResponse, readAdmittedBody, readAdmittedBytes,
  releaseWhenResponseEnds, requestTooLargeResponse, type InflightBudget,
} from '@kortix/llm-gateway';
import type { AudioRequest, ClaudeCodeRequest, RequestOrigin, VoicesRequest } from '@kortix/llm-gateway';
import type { Hono } from 'hono';
import { cloudflareSafe, messagesAuthorization, perRequestCapBytes } from './server';

type Protocol = 'chat' | 'messages' | 'responses' | 'images' | 'audio';
type InferenceRequest = { authorization: string | undefined; rawBody: string; signal?: AbortSignal; origin?: RequestOrigin };
type Gateway = {
  chatCompletions: (request: InferenceRequest) => Promise<Response>;
  messages: (request: InferenceRequest) => Promise<Response>;
  responses: (request: InferenceRequest) => Promise<Response>;
  listModels: (authorization: string | undefined, options: { managedOnly: boolean; scope?: 'picker' }, openAiList: boolean) => Promise<Response>;
  images: (request: InferenceRequest & { operation: 'generations' | 'edits' }) => Promise<Response>;
  audio: (request: AudioRequest) => Promise<Response>;
  voices: (request: VoicesRequest) => Promise<Response>;
  claudeCode: (request: ClaudeCodeRequest) => Promise<Response>;
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

function inference(
  inflight: InflightBudget,
  recordOutcome: (status: number) => void,
  protocol: Protocol,
  call: (request: InferenceRequest) => Promise<Response>,
) {
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
          // The session message the call comes from, for the request log.
          origin: readRequestOrigin((name) => c.req.header(name)),
        };
        body.body = '';
        const res = await cloudflareSafe(await call(request));
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
 * Speech-to-text and text-to-speech (pipeline/audio.ts). The body is admitted
 * against the same in-flight budget as every inference body, and kept as
 * bytes: a transcription upload is multipart audio, which a text decode
 * would corrupt.
 */
function audio(gateway: Gateway, inflight: InflightBudget, recordOutcome: (status: number) => void, operation: AudioRequest['operation']) {
  return async (c: { req: { raw: Request; header: (name: string) => string | undefined } }) => {
    // Read before the body is consumed: for a Request built from FormData, Bun
    // derives the content type (the multipart boundary) from the unread body.
    const contentType = c.req.header('content-type') ?? '';
    try {
      const body = await readAdmittedBytes(c.req.raw, perRequestCapBytes, inflight);
      if (!body.ok) {
        const status = body.reason === 'too_large' ? 413 : 503;
        if (body.reason !== 'client_aborted') recordOutcome(status);
        return status === 413 ? requestTooLargeResponse() : gatewayOverloadedResponse(body.retryAfterSeconds ?? 1);
      }
      try {
        const request: AudioRequest = {
          operation,
          authorization: c.req.header('authorization'),
          contentType,
          body: body.body,
          signal: c.req.raw.signal,
        };
        body.body = new Uint8Array(0);
        const res = await cloudflareSafe(await gateway.audio(request));
        recordOutcome(res.status);
        return releaseWhenResponseEnds(res, body.release);
      } catch (error) {
        body.release();
        throw error;
      }
    } catch (error) {
      console.error(`[gateway] audio.${operation} request failed`, error);
      recordOutcome(503);
      return failure('audio', '');
    }
  };
}

/**
 * Claude Code's own Anthropic requests (`{prefix}claude-code/v1/messages`,
 * `…/v1/messages/count_tokens`, `…/api/hello`), passed through on a stored
 * Claude account. The body is admitted against the same in-flight budget as
 * every inference request and forwarded byte for byte.
 */
function claudeCode(gateway: Gateway, inflight: InflightBudget, recordOutcome: (status: number) => void) {
  return async (c: { req: { raw: Request; path: string } }) => {
    const raw = c.req.raw;
    const marker = '/claude-code';
    const path = c.req.path.slice(c.req.path.indexOf(marker) + marker.length) || '/';
    const search = new URL(raw.url).search;
    if (raw.method !== 'POST') return gateway.claudeCode({ method: raw.method, path, search, headers: raw.headers, body: null });
    const body = await readAdmittedBody(raw, perRequestCapBytes, inflight);
    if (!body.ok) {
      const status = body.reason === 'too_large' ? 413 : 503;
      if (body.reason !== 'client_aborted') recordOutcome(status);
      return status === 413 ? requestTooLargeResponse() : gatewayOverloadedResponse(body.retryAfterSeconds ?? 1);
    }
    try {
      const bytes = new TextEncoder().encode(body.body);
      body.body = '';
      const res = await gateway.claudeCode({ method: 'POST', path, search, headers: raw.headers, body: bytes, signal: raw.signal });
      recordOutcome(res.status);
      return releaseWhenResponseEnds(res, body.release);
    } catch (error) {
      body.release();
      console.error('[gateway] claude-code request failed', error);
      recordOutcome(503);
      return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Gateway unavailable' } }),
        { status: 503, headers: { 'content-type': 'application/json' } });
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
 * `models` → the OpenAI `{object:'list',data}` of the models the key can call;
 * `?scope=managed` → managed lineup only (~3KB); `?scope=picker` → the
 * project's servable set (~80KB), fetched by sandboxes on every boot so their
 * `kortix` provider matches the web picker; `?scope=all` → the full discovery
 * catalog. See wire.ts.
 * `audio/transcriptions` (multipart), `audio/speech` (streamed audio) and
 * `audio/voices?model=` are the OpenAI audio shapes, served by Kortix's
 * managed audio models and billed at the price the upstream reports.
 */
export function registerRoutes(
  app: Hono,
  gateway: Gateway,
  inflight: InflightBudget,
  recordOutcome: (status: number) => void,
  rateLimit: (request: Request, headers?: Headers) => Response | null,
) {
  // Every model route checks the per-credential limit first (token-rate-limit.ts).
  const limited = <C extends { req: { raw: Request } }>(handler: (c: C) => Promise<Response>) =>
    async (c: C) => {
      const headers = new Headers();
      const response = rateLimit(c.req.raw, headers) ?? await handler(c);
      headers.forEach((value, name) => response.headers.set(name, value));
      return response;
    };
  const chat = limited(inference(inflight, recordOutcome, 'chat', gateway.chatCompletions));
  const messages = limited(inference(inflight, recordOutcome, 'messages', gateway.messages));
  const responses = limited(inference(inflight, recordOutcome, 'responses', gateway.responses));
  // The project's ChatGPT login generates and edits images (pipeline/images.ts).
  // A thrown error gets the Responses-style 503 envelope.
  const images = (operation: 'generations' | 'edits') =>
    limited(inference(inflight, recordOutcome, 'images', (request) => gateway.images({ ...request, operation })));
  const generations = images('generations');
  const edits = images('edits');
  const transcriptions = limited(audio(gateway, inflight, recordOutcome, 'transcriptions'));
  const speech = limited(audio(gateway, inflight, recordOutcome, 'speech'));
  const voices = limited((c: { req: { raw: Request; header: (name: string) => string | undefined; query: (name: string) => string | undefined } }) =>
    gateway.voices({ authorization: c.req.header('authorization'), model: c.req.query('model') ?? '', signal: c.req.raw.signal })
      .then(cloudflareSafe));
  const claude = limited(claudeCode(gateway, inflight, recordOutcome));
  // Unscoped (or an unknown scope) is the OpenAI `GET /models` a client picks
  // its model from, so it lists only what this key can call (KRTX-4427).
  // `all` is the full discovery catalog; `picker` and `managed` stay maps.
  const models = limited((c: { req: { raw: Request; header: (name: string) => string | undefined; query: (name: string) => string | undefined } }) => {
    const scope = c.req.query('scope');
    const openAiList = scope !== 'managed' && scope !== 'picker' && scope !== 'all';
    return gateway.listModels(c.req.header('authorization'), {
      managedOnly: scope === 'managed',
      scope: scope === 'picker' || openAiList ? 'picker' : undefined,
    }, openAiList).then(cloudflareSafe);
  });
  for (const prefix of ['/', '/v1/', '/v1/llm/', '/v1/openai/']) {
    app.all(prefix + 'claude-code/*', claude);
    app.post(prefix + 'chat/completions', chat);
    app.post(prefix + 'messages', messages);
    app.post(prefix + 'responses', responses);
    app.post(prefix + 'images/generations', generations);
    app.post(prefix + 'images/edits', edits);
    app.post(prefix + 'audio/transcriptions', transcriptions);
    app.post(prefix + 'audio/speech', speech);
    app.get(prefix + 'audio/voices', voices);
    app.get(prefix + 'models', models);
  }
}
