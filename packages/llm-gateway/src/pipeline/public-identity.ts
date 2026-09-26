import type { UpstreamDescriptor } from '../domain';

// A descriptor with `publicProvider` serves a model that users know by the
// gateway's own name (Kortix-managed models). Nothing a client or a
// customer-visible record can read may name the upstream that served it: not
// the provider, not its model id, not its error text, not its headers. These
// helpers produce the public view. The upstream identity stays in server logs
// and in `UsageEvent.upstream`.

/** The provider name a client may see for `descriptor`. */
export function shownProvider(descriptor: UpstreamDescriptor): string {
  return descriptor.publicProvider ?? descriptor.provider;
}

/** The model id a client may see for `descriptor`, given the routed model. */
export function shownModel(descriptor: UpstreamDescriptor, routedModel: string): string {
  return descriptor.publicProvider ? routedModel : descriptor.resolvedModel ?? routedModel;
}

export interface PublicUpstreamError {
  status: number;
  code: string;
  message: string;
  suggestion: string;
}

const CONTEXT_LENGTH = /context|too many tokens|maximum.{0,40}tokens|prompt is too long|too long|max_tokens/i;
const IMAGE_INPUT = /image|vision|multimodal|modalit/i;
const TOOL_DEFINITION = /tool|function|schema/i;

/**
 * Classify an upstream failure (`status` 0 = no HTTP response) into the error a
 * managed-model client receives. The upstream text only selects the rule; it
 * is never copied into the result.
 *
 * - 429 stays 429 so OpenCode retries it.
 * - A request-shape 4xx stays 400 with the most specific code the text allows.
 * - Everything else (the gateway's own key rejected, provider down, network
 *   error, timeout) is a 503: the user cannot fix it, and a retry may succeed.
 */
export function publicUpstreamError(status: number, upstreamText: string, model: string): PublicUpstreamError {
  if (status === 429) {
    return {
      status: 429,
      code: 'model_busy',
      message: `${model} is at capacity right now.`,
      suggestion: 'Retry in a few seconds, or choose another model.',
    };
  }
  if (status === 400 || status === 413 || status === 422) {
    if (CONTEXT_LENGTH.test(upstreamText)) {
      return {
        status: 400,
        code: 'context_length_exceeded',
        message: `This request is longer than the ${model} context window.`,
        suggestion: 'Compact the conversation or start a new session.',
      };
    }
    if (IMAGE_INPUT.test(upstreamText)) {
      return {
        status: 400,
        code: 'unsupported_input',
        message: `${model} could not read an attachment in this request.`,
        suggestion: 'Remove the attachment or choose a model that supports it.',
      };
    }
    if (TOOL_DEFINITION.test(upstreamText)) {
      return {
        status: 400,
        code: 'invalid_tool_definition',
        message: `${model} rejected a tool definition in this request.`,
        suggestion: 'Check the tool schemas, or choose another model.',
      };
    }
    return {
      status: 400,
      code: 'invalid_request',
      message: `${model} rejected this request.`,
      suggestion: 'Retry the request, or choose another model.',
    };
  }
  return {
    status: 503,
    code: 'model_unavailable',
    message: `${model} is temporarily unavailable.`,
    suggestion: 'Retry in a few seconds, or choose another model.',
  };
}

/**
 * The public form of one OpenAI-compatible completion object or SSE event:
 * `model` is the routed model, `provider` is removed, and an in-band `error`
 * is replaced by its classified public error.
 */
export function publicPayload(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const { provider: _provider, ...rest } = payload;
  if ('model' in rest) rest.model = model;
  if (rest.error && typeof rest.error === 'object') {
    const upstream = rest.error as { code?: unknown; status?: unknown };
    const code = Number(upstream.code ?? upstream.status);
    const classified = publicUpstreamError(Number.isFinite(code) ? code : 0, JSON.stringify(rest.error), model);
    rest.error = { message: classified.message, code: classified.code, type: classified.code };
  }
  return rest;
}

/** Remove upstream comments and rewrite every `data: {…}` line for the public stream. */
export function publicSseLines(text: string, model: string): string {
  return text.replace(/^:[^\r\n]*(?:\r?\n|$)/gm, '').replace(/^data: (\{.*\})\r?$/gm, (line, json: string) => {
    try {
      return `data: ${JSON.stringify(publicPayload(JSON.parse(json) as Record<string, unknown>, model))}`;
    } catch {
      return line;
    }
  });
}

const PUBLIC_RESPONSE_HEADERS = ['content-type', 'cache-control'];

/** The only upstream response headers a managed-model client receives. */
export function publicResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of PUBLIC_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}
