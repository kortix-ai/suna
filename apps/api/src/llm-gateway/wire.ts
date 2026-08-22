import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { config } from '../config';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { createInternalGatewayRoutes } from './internal-routes';

// ─── OpenAPI documentation for the inference surface ────────────────────────
//
// These endpoints are OpenAI/Anthropic *compatibility* surfaces: the gateway
// forwards the request body to an upstream provider close to verbatim, so the
// schemas below are intentionally permissive (`.passthrough()` / `z.any()`)
// rather than a strict re-implementation of the OpenAI/Anthropic wire format.
// They exist to make the Scalar page genuinely useful (documented fields +
// examples), not to gate what the proxy accepts.
//
// IMPORTANT: these routes are registered with `openAPIRegistry.registerPath()`
// directly — NOT `llm.openapi(route, handler)` — for the POST/body-bearing ones.
// `.openapi()` would wire `@hono/zod-openapi`'s zValidator("json", schema)
// middleware in front of the handler, and a validation failure there returns
// the SHARED `{error:true,message:"Validation failed",...}` envelope instead of
// the gateway's own OpenAI/Anthropic-shaped error body — changing the wire
// contract for a compatibility surface whose whole point is to match those
// SDKs' expectations (see `/v1/router/chat/completions` in router/routes/llm.ts,
// which avoids attaching a body schema for the same reason). `registerPath()`
// adds the operation (incl. the documented request body below) to the SAME
// OpenAPI registry `.openapi()` would have, WITHOUT touching request handling
// at all — the actual runtime route is still a plain `llm.post()/get()` with
// the original, unmodified handler.
const GATEWAY_INFERENCE_TAG = 'gateway-inference';

const AUTH_DESCRIPTION =
  'Bearer token: a project gateway key (`kortix_gw_…`, created via ' +
  'POST /v1/projects/{projectId}/gateway/keys) or a Kortix account token ' +
  '(PAT `kortix_pat_…`, API key, or sandbox key). Unlike most of the API, the ' +
  'raw Supabase user JWT is NOT accepted here — mint a gateway key or PAT first.';

const ChatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']).openapi({ example: 'user' }),
    content: z
      .union([z.string(), z.array(z.record(z.string(), z.any()))])
      .openapi({ example: 'Hello!' }),
  })
  .passthrough()
  .openapi('GatewayChatMessage');

const ChatCompletionRequestExampleSchema = z
  .object({
    model: z.string().openapi({ example: 'claude-sonnet-4-5' }),
    messages: z.array(ChatMessageSchema).min(1),
    stream: z.boolean().optional().openapi({
      description:
        'When true, the response is `text/event-stream` SSE of `chat.completion.chunk` events instead of a single JSON object.',
    }),
    tools: z.array(z.record(z.string(), z.any())).optional(),
    tool_choice: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().optional().openapi({
      description: 'Legacy alias for max_completion_tokens, honored for compatibility.',
    }),
    max_completion_tokens: z.number().optional(),
    response_format: z.record(z.string(), z.any()).optional(),
    seed: z.number().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  })
  .passthrough()
  .openapi('GatewayChatCompletionRequest', {
    example: {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Say hello in one word.' }],
      stream: false,
      max_completion_tokens: 128,
    },
  });

const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    object: z.literal('chat.completion'),
    created: z.number(),
    model: z.string(),
    choices: z.array(z.record(z.string(), z.any())),
    usage: z.record(z.string(), z.any()).optional(),
  })
  .passthrough()
  .openapi('GatewayChatCompletionResponse', {
    example: {
      id: 'chatcmpl_abc123',
      object: 'chat.completion',
      created: 1737072000,
      model: 'claude-sonnet-4-5',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    },
  });

const CHAT_COMPLETIONS_RESPONSES = {
  200: {
    description:
      'Chat completion. A single `chat.completion` JSON object when `stream` is falsy; ' +
      'a `text/event-stream` SSE stream of `chat.completion.chunk` frames (terminated by ' +
      '`data: [DONE]`) when `stream: true`.',
    content: {
      'application/json': { schema: ChatCompletionResponseSchema },
      'text/event-stream': {
        schema: z.string().openapi({
          example:
            'data: {"id":"chatcmpl_abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n',
        }),
      },
    },
  },
  ...errors(400, 401, 402, 413, 429, 502),
};

function chatCompletionsRoute(path: string) {
  const fullPath = `/v1/llm${path}`;
  return createRoute({
    method: 'post' as const,
    path,
    tags: [GATEWAY_INFERENCE_TAG],
    summary: `POST ${fullPath}`,
    description: `OpenAI-compatible chat completions, proxied through the Kortix LLM gateway (model routing/failover, budgets, usage billing, and request tracing all apply). The body is forwarded close to verbatim to the resolved upstream provider.\n\nAuth: ${AUTH_DESCRIPTION}\n\n\`\`\`\ncurl -sS $KORTIX_API_URL${fullPath} \\\n  -H "Authorization: Bearer $KORTIX_GATEWAY_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"Say hello in one word."}]}\'\n\`\`\``,
    ...auth,
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: ChatCompletionRequestExampleSchema } },
      },
    },
    responses: CHAT_COMPLETIONS_RESPONSES,
  });
}

const AnthropicMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']).openapi({ example: 'user' }),
    content: z
      .union([z.string(), z.array(z.record(z.string(), z.any()))])
      .openapi({ example: 'Hello!' }),
  })
  .passthrough()
  .openapi('GatewayAnthropicMessage');

const MessagesRequestExampleSchema = z
  .object({
    model: z.string().openapi({ example: 'claude-sonnet-4-5' }),
    system: z.union([z.string(), z.array(z.record(z.string(), z.any()))]).optional(),
    messages: z.array(AnthropicMessageSchema).min(1),
    max_tokens: z.number().openapi({ example: 1024 }),
    tools: z.array(z.record(z.string(), z.any())).optional(),
    tool_choice: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    stop_sequences: z.array(z.string()).optional(),
    stream: z.boolean().optional().openapi({
      description:
        'When true, the response is Anthropic-shaped SSE: message_start, content_block_delta*, message_delta, message_stop.',
    }),
  })
  .passthrough()
  .openapi('GatewayMessagesRequest', {
    example: {
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Say hello in one word.' }],
    },
  });

const MessagesResponseSchema = z
  .object({
    id: z.string(),
    type: z.literal('message'),
    role: z.literal('assistant'),
    model: z.string(),
    content: z.array(z.record(z.string(), z.any())),
    stop_reason: z.string().nullable().optional(),
    usage: z.record(z.string(), z.any()).optional(),
  })
  .passthrough()
  .openapi('GatewayMessagesResponse', {
    example: {
      id: 'msg_abc123',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Hello!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  });

const MESSAGES_RESPONSES = {
  200: {
    description:
      'Anthropic Messages response. A single `message` JSON object when `stream` is falsy; ' +
      'Anthropic-shaped `text/event-stream` SSE (`message_start` → `content_block_delta`* → ' +
      '`message_delta` → `message_stop`) when `stream: true`.',
    content: {
      'application/json': { schema: MessagesResponseSchema },
      'text/event-stream': {
        schema: z.string().openapi({
          example:
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_abc123","role":"assistant"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        }),
      },
    },
  },
  ...errors(400, 401, 402, 413, 429, 502),
};

function messagesRoute(path: string) {
  const fullPath = `/v1/llm${path}`;
  return createRoute({
    method: 'post' as const,
    path,
    tags: [GATEWAY_INFERENCE_TAG],
    summary: `POST ${fullPath}`,
    description: `Anthropic-Messages-compatible ingress. Translated at the edges only — the request is converted to the gateway\'s internal chat.completions shape, driven through the SAME auth/billing/routing/failover/trace pipeline as chat completions, then the response (or SSE stream) is translated back to the Anthropic Messages wire format.\n\nAuth: ${AUTH_DESCRIPTION}\n\n\`\`\`\ncurl -sS $KORTIX_API_URL${fullPath} \\\n  -H "Authorization: Bearer $KORTIX_GATEWAY_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model":"claude-sonnet-4-5","max_tokens":1024,"messages":[{"role":"user","content":"Say hello in one word."}]}\'\n\`\`\``,
    ...auth,
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: MessagesRequestExampleSchema } },
      },
    },
    responses: MESSAGES_RESPONSES,
  });
}

// The reasoning_options entry shape — three real forms models.dev emits
// (effort/toggle/budget_tokens; see @kortix/llm-catalog's
// CatalogReasoningOption for the full field-by-field rationale). All fields
// but `type` optional so one schema covers all three without a oneOf.
const GatewayModelReasoningOptionSchema = z
  .object({
    type: z.string(),
    values: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .openapi('GatewayModelReasoningOption');

const GatewayModelCostTierSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
    tier: z.object({ type: z.string(), size: z.number() }).optional(),
  })
  .openapi('GatewayModelCostTier');

const GatewayModelCostSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
    tiers: z.array(GatewayModelCostTierSchema).optional(),
    context_over_200k: GatewayModelCostTierSchema.optional(),
  })
  .openapi('GatewayModelCost');

const GatewayModelModalitiesSchema = z
  .object({
    input: z.array(z.string()).optional(),
    output: z.array(z.string()).optional(),
  })
  .openapi('GatewayModelModalities');

// Documents the ACTUAL served shape (see catalog-models.ts's `GatewayModel`)
// — this used to lag behind reality (no `provider`, no reasoning_options/
// cost/modalities/structured_output/knowledge/limit.input), so the published
// OpenAPI contract didn't match what GET /v1/models actually returns.
const GatewayModelSchema = z
  .object({
    name: z.string(),
    released: z.string().nullable().optional(),
    release_date: z.string().nullable().optional(),
    family: z.string().optional(),
    // The REAL upstream provider this model resolves against ('anthropic',
    // 'openai', 'codex', 'kortix', ...) — every gateway model is registered
    // under the single synthetic `kortix` opencode provider, so this is the
    // field a client groups/labels by instead of parsing the wire model id.
    provider: z.string().optional(),
    reasoning: z.boolean().optional(),
    reasoning_options: z.array(GatewayModelReasoningOptionSchema).optional(),
    tool_call: z.boolean().optional(),
    attachment: z.boolean().optional(),
    temperature: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    knowledge: z.string().optional(),
    description: z.string().optional(),
    open_weights: z.boolean().optional(),
    last_updated: z.string().optional(),
    modalities: GatewayModelModalitiesSchema.optional(),
    cost: GatewayModelCostSchema.optional(),
    limit: z
      .object({
        context: z.number().optional(),
        input: z.number().optional(),
        output: z.number().optional(),
      })
      .optional(),
  })
  .openapi('GatewayModel');

const ModelsResponseSchema = z
  .object({ models: z.record(z.string(), GatewayModelSchema) })
  .openapi('GatewayModelCatalog', {
    example: {
      models: {
        'claude-sonnet-4-5': {
          name: 'Claude Sonnet 4.5',
          family: 'claude',
          provider: 'anthropic',
          reasoning: true,
          reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
          tool_call: true,
          attachment: true,
          temperature: true,
          limit: { context: 200000, output: 64000 },
        },
      },
    },
  });

function modelsRoute(path: string) {
  const fullPath = `/v1/llm${path}`;
  return createRoute({
    method: 'get' as const,
    path,
    tags: [GATEWAY_INFERENCE_TAG],
    summary: `GET ${fullPath}`,
    description: `Servable model catalog for the caller\'s account/project — a keyed object (NOT the OpenAI \`{object:"list",data:[...]}\` array shape) mapping model id → capabilities.\n\nAuth: ${AUTH_DESCRIPTION}\n\n\`\`\`\ncurl -sS $KORTIX_API_URL${fullPath} -H "Authorization: Bearer $KORTIX_GATEWAY_KEY"\n\`\`\``,
    request: {
      query: z.object({
        scope: z
          .enum(['managed'])
          .optional()
          .openapi({
            description:
              'Set to `managed` for the platform-managed lineup only (~3KB instead of ~3.3MB). Sandboxes call this on every boot to learn the current managed set. Omit for the caller\'s full catalog.',
            example: 'managed',
          }),
      }),
    },
    ...auth,
    responses: { 200: json(ModelsResponseSchema, 'Servable model catalog'), ...errors(401, 502) },
  });
}

// The API is the gateway control plane and a streaming network bridge only.
// Inference never runs in this process. A malformed or memory-heavy model
// request can therefore terminate only a disposable gateway worker, never the
// API that owns auth, sessions, billing, and project state.
export function mountLlmGateway(app: OpenAPIHono): void {
  app.route('/internal/gateway', createInternalGatewayRoutes());

  const rawTarget =
    config.LLM_GATEWAY_PROXY_TARGET ||
    (config.LLM_GATEWAY_PROXY_PORT
      ? `http://127.0.0.1:${config.LLM_GATEWAY_PROXY_PORT}`
      : '');
  let proxyBase: string | null = null;
  if (rawTarget) {
    try {
      const url = new URL(rawTarget);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not HTTP');
      proxyBase = rawTarget.replace(/\/+$/, '');
    } catch (error) {
      console.error('[gateway] invalid standalone gateway target:', error);
    }
  }

  const proxy = async (c: import('hono').Context, path: string): Promise<Response> => {
    if (!config.LLM_GATEWAY_ENABLED) {
      return c.json({ error: 'LLM gateway is disabled', code: 'gateway_disabled' }, 503);
    }
    if (!proxyBase) {
      return c.json(
        { error: 'Standalone LLM gateway is not configured', code: 'gateway_unavailable' },
        503,
      );
    }

    const headers = new Headers(c.req.raw.headers);
    headers.delete('host');
    headers.delete('connection');
    const query = new URL(c.req.url).search;
    const init: RequestInit & { duplex?: 'half' } = { method: c.req.method, headers };
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      init.body = c.req.raw.body;
      init.duplex = 'half';
    }
    try {
      const upstream = await fetch(`${proxyBase}${path}${query}`, init);
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch (error) {
      console.error('[gateway] standalone gateway unreachable:', error);
      return c.json(
        { error: 'Standalone LLM gateway is unreachable', code: 'gateway_proxy_unreachable' },
        502,
      );
    }
  };

  const llm = makeOpenApiApp();
  llm.openAPIRegistry.registerPath(chatCompletionsRoute('/chat/completions'));
  llm.openAPIRegistry.registerPath(modelsRoute('/models'));
  llm.openAPIRegistry.registerPath(messagesRoute('/messages'));
  llm.openAPIRegistry.registerPath(chatCompletionsRoute('/v1/chat/completions'));
  llm.openAPIRegistry.registerPath(modelsRoute('/v1/models'));
  llm.openAPIRegistry.registerPath(messagesRoute('/v1/messages'));
  llm.all('*', (c) => {
    const tail = c.req.path.slice('/v1/llm'.length) || '/';
    return proxy(c, tail);
  });
  app.route('/v1/llm', llm);

  // Temporary compatibility alias for clients configured with the old proxy
  // prefix. New clients use /v1/llm directly.
  app.all('/v1/llm-gateway/*', (c) => {
    const tail = c.req.path.slice('/v1/llm-gateway'.length) || '/';
    return proxy(c, tail);
  });
}
