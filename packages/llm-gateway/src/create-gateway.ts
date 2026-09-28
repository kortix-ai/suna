import type { GatewayHooks, ListModelsOptions } from './domain';
import {
  type AnthropicMessagesRequest,
  anthropicMessagesToChat,
  chatJsonToAnthropicMessage,
  chatSseToAnthropicSse,
} from './ingress/anthropic-messages';
import {
  chatJsonToResponsesObject,
  chatSseToResponsesSse,
  type ResponsesRequest,
  responsesToChat,
} from './ingress/openai-responses';
import {
  type ChatCompletionRequest,
  type GatewayDeps,
  type HandlerRuntime,
  handleChatCompletions,
} from './pipeline';
import { parseUpstreamErrorBody } from './http/parse-upstream-error';
import { gatewayErrorResponse } from './pipeline/error-response';

// Anthropic Messages API error `type` values by HTTP status — used only to
// shape the JSON envelope for clients speaking the Anthropic wire format; the
// underlying gateway error codes/messages (from `gatewayErrorBody`) are
// unchanged and still drive the OpenAI-compat surface.
const ANTHROPIC_ERROR_TYPE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'invalid_request_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'api_error',
  503: 'overloaded_error',
  529: 'overloaded_error',
};

function anthropicErrorType(status: number): string {
  return ANTHROPIC_ERROR_TYPE_BY_STATUS[status] ?? 'api_error';
}

function anthropicErrorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: anthropicErrorType(status), message } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

// Responses API error `type` values by HTTP status, mirroring OpenAI's own
// `/v1/responses` error envelope (`{error:{message,type,code}}`, no top-level
// `type` field — that's an Anthropic-ism).
const RESPONSES_ERROR_TYPE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'invalid_request_error',
  402: 'invalid_request_error',
  403: 'invalid_request_error',
  404: 'invalid_request_error',
  413: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'server_error',
  502: 'server_error',
  503: 'server_error',
};

function responsesErrorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      error: { type: RESPONSES_ERROR_TYPE_BY_STATUS[status] ?? 'server_error', message, code: null, param: null },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

export function createGateway(hooks: GatewayHooks, deps: GatewayDeps = {}) {
  const logger = deps.logger ?? console;
  const runtime: HandlerRuntime = {
    hooks,
    logger,
    fetchImpl: deps.fetchImpl,
    imageWindow: deps.imageWindow,
  };

  const jsonResponse = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  const bearer = (header: string | undefined): string | null => {
    const match = header?.match(/^Bearer\s+(\S.*)$/i);
    return match ? match[1].trim() : null;
  };

  const listModels = async (
    authorization: string | undefined,
    opts?: ListModelsOptions,
  ): Promise<Response> => {
    const requestId = `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const token = bearer(authorization);
    if (!token)
      return gatewayErrorResponse(401, {
        message: 'Missing bearer token',
        code: 'missing_token',
        provider: '',
        requestedModel: '',
        resolvedModel: '',
        requestId,
        suggestion: 'Sign in again or provide a valid API token, then retry.',
      });
    try {
      const principal = await hooks.authenticate(token);
      if (!principal)
        return gatewayErrorResponse(401, {
          message: 'Invalid token',
          code: 'invalid_token',
          provider: '',
          requestedModel: '',
          resolvedModel: '',
          requestId,
          suggestion: 'Sign in again or provide a valid API token, then retry.',
        });
      if (!hooks.listModels) return jsonResponse({ models: {} });
      const models = await hooks.listModels(principal, opts);
      logger.info(
        `[gateway] models ${Object.keys(models).length}${opts?.managedOnly ? ' (managed only)' : opts?.scope === 'picker' ? ' (picker)' : ''} ` +
          `for acct=${principal.accountId.slice(0, 8)}`,
      );
      return jsonResponse({ models });
    } catch (err) {
      logger.error('[gateway] model catalog request failed', err);
      return gatewayErrorResponse(502, {
        message: 'Model catalog unavailable',
        code: 'models_error',
        provider: '',
        requestedModel: '',
        resolvedModel: '',
        requestId,
        suggestion: 'Retry the request. If the error continues, reconnect the provider.',
      });
    }
  };

  // Anthropic Messages API ingress: translate the Anthropic-shaped request
  // into the internal OpenAI chat.completions representation, use the same
  // auth/routing/dispatch/settlement path, then translate the response back.
  // Translation happens entirely around the pipeline call — the pipeline
  // itself never sees or produces Anthropic-shaped data.
  const messages = async (req: ChatCompletionRequest): Promise<Response> => {
    let anthropicBody: Record<string, unknown>;
    try {
      anthropicBody = JSON.parse(req.rawBody) as Record<string, unknown>;
      req.rawBody = '';
    } catch {
      req.rawBody = '';
      return anthropicErrorResponse(400, 'Invalid JSON body');
    }

    const streaming = anthropicBody.stream === true;
    const chatBody = anthropicMessagesToChat(anthropicBody as unknown as AnthropicMessagesRequest);
    // Read what the response translation needs BEFORE dispatch, so neither the
    // Anthropic body nor the translated one has to stay reachable across the
    // upstream call.
    const model = typeof chatBody.model === 'string' ? chatBody.model : undefined;
    (anthropicBody as unknown) = null;

    const upstream = await handleChatCompletions(runtime, {
      authorization: req.authorization,
      rawBody: '',
      parsedBody: chatBody as Record<string, unknown>,
      signal: req.signal,
    });

    if (!upstream.ok) {
      // The gateway's own errors carry a top-level `message`; a relayed
      // provider error carries `{error:{message}}` or `{detail}`. Both reach
      // the client, so it sees why the provider refused.
      const message = parseUpstreamErrorBody(await upstream.text().catch(() => '')).message;
      return anthropicErrorResponse(upstream.status, message);
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    if (streaming && contentType.includes('text/event-stream') && upstream.body) {
      const anthropicStream = chatSseToAnthropicSse(upstream.body, { model });
      return new Response(anthropicStream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    }

    const data = await upstream.json().catch(() => null);
    if (!data) return anthropicErrorResponse(502, 'Invalid upstream response');
    return jsonResponse(chatJsonToAnthropicMessage(data as Record<string, unknown>));
  };

  // OpenAI Responses API ingress (`POST /responses`): Codex CLI >=0.157 only
  // supports `wire_api = "responses"`, so it must land here rather than on
  // `/chat/completions`. Translate the Responses-shaped request into the
  // internal chat.completions representation, run it through the SAME
  // auth/routing/dispatch/settlement path as every other ingress, then
  // translate the response back. `codex/*` routing to the ChatGPT backend is
  // unaffected by which ingress produced the internal body — see
  // ingress/openai-responses.ts's module doc comment.
  const responses = async (req: ChatCompletionRequest): Promise<Response> => {
    let responsesBody: Record<string, unknown>;
    try {
      responsesBody = JSON.parse(req.rawBody) as Record<string, unknown>;
      req.rawBody = '';
    } catch {
      req.rawBody = '';
      return responsesErrorResponse(400, 'Invalid JSON body');
    }

    const streaming = responsesBody.stream === true;
    const chatBody = responsesToChat(responsesBody as unknown as ResponsesRequest);
    const model = typeof chatBody.model === 'string' ? chatBody.model : undefined;
    (responsesBody as unknown) = null;

    const upstream = await handleChatCompletions(runtime, {
      authorization: req.authorization,
      rawBody: '',
      parsedBody: chatBody as Record<string, unknown>,
      signal: req.signal,
    });

    if (!upstream.ok) {
      const message = parseUpstreamErrorBody(await upstream.text().catch(() => '')).message;
      return responsesErrorResponse(upstream.status, message);
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    if (streaming && contentType.includes('text/event-stream') && upstream.body) {
      const responsesStream = chatSseToResponsesSse(upstream.body, { model });
      return new Response(responsesStream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    }

    const data = await upstream.json().catch(() => null);
    if (!data) return responsesErrorResponse(502, 'Invalid upstream response');
    return jsonResponse(chatJsonToResponsesObject(data as Record<string, unknown>));
  };

  return {
    chatCompletions: (req: ChatCompletionRequest): Promise<Response> =>
      handleChatCompletions(runtime, req),
    messages,
    responses,
    listModels,
  };
}
