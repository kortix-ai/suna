import type { UpstreamDescriptor } from '../../domain';
import type { UpstreamRequest } from '../openai-compat';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
// When the client asks for extended thinking but doesn't set its own
// max_tokens, the default above (4096) is too small to hold both the
// thinking budget and a real answer — Anthropic requires
// `thinking.budget_tokens < max_tokens`. Give thinking requests a generous
// default ceiling instead of silently clamping the budget down to near-zero.
const DEFAULT_MAX_TOKENS_WITH_THINKING = 32_000;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function anthropicModelName(model: string): string {
  return model.replace(/(\d)\.(\d)/g, '$1-$2');
}

function safeParse(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as any).text ?? '') : ''))
      .join('');
  }
  return '';
}

function translateUserContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textOf(content);
  return content.map((part: any) => {
    if (part?.type === 'text') return { type: 'text', text: part.text };
    if (part?.type === 'image_url') {
      const url: string = part.image_url?.url ?? '';
      if (url.startsWith('data:')) {
        const comma = url.indexOf(',');
        const meta = url.slice(5, comma);
        const data = url.slice(comma + 1);
        const mediaType = meta.split(';')[0] || 'image/png';
        return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
      }
      return { type: 'image', source: { type: 'url', url } };
    }
    return part;
  });
}

function translateMessages(messages: any[]): { system?: string; messages: any[] } {
  const systemParts: string[] = [];
  const out: any[] = [];
  for (const m of messages ?? []) {
    if (m.role === 'system') {
      systemParts.push(textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const content: any[] = [];
      const text = textOf(m.content);
      if (text) content.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: safeParse(tc.function?.arguments) });
      }
      out.push({ role: 'assistant', content: content.length ? content : '' });
      continue;
    }
    out.push({ role: 'user', content: translateUserContent(m.content) });
  }
  return { system: systemParts.filter(Boolean).join('\n\n') || undefined, messages: out };
}

function translateTools(tools: any[]): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .filter((t) => t?.function?.name)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
}

function translateToolChoice(tc: unknown): unknown {
  if (tc === 'required') return { type: 'any' };
  // 'auto' (and omitted/null) map to `undefined` because Anthropic's own
  // default when `tools` are present is already `{type:'auto'}` — no need to
  // send it explicitly. 'none' must NOT collapse the same way: Anthropic has
  // no implicit "don't use tools" default, so omitting tool_choice here while
  // `tools` is still attached would silently let Claude call a tool the
  // caller explicitly forbade (SAFETY: gateway audit finding, tool_choice:'none'
  // regression). `{type:'none'}` is a distinct, documented Anthropic value.
  if (tc === 'auto' || tc == null) return undefined;
  if (tc === 'none') return { type: 'none' };
  if (typeof tc === 'object' && (tc as any).function?.name) return { type: 'tool', name: (tc as any).function.name };
  return undefined;
}

// Client-supplied `reasoning_effort` (OpenAI/opencode-shaped) maps to a
// concrete Anthropic `thinking.budget_tokens`. Coarse but documented — an
// explicit `budget_tokens`/`max_tokens` on `body.reasoning`, or a raw
// Anthropic-shaped `body.thinking` block, always wins over this table.
const REASONING_EFFORT_BUDGET_TOKENS: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16000,
  max: 32000,
};

// Client-requested reasoning/extended-thinking previously vanished silently
// for Anthropic (and Bedrock, which shares this payload builder): the gateway
// only forwarded it for the openai-responses transport. Translate whatever
// shape the client sent into Anthropic's `thinking: {type:'enabled',
// budget_tokens}` block instead of dropping it.
function translateThinking(body: Record<string, any>): { type: 'enabled'; budget_tokens: number } | undefined {
  // Already Anthropic-shaped — pass through verbatim (still subject to the
  // budget_tokens < max_tokens clamp applied by the caller).
  if (body.thinking && typeof body.thinking === 'object') {
    const budget = (body.thinking as any).budget_tokens;
    if ((body.thinking as any).type === 'enabled' && typeof budget === 'number' && budget > 0) {
      return { type: 'enabled', budget_tokens: budget };
    }
    return undefined;
  }

  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === 'object') {
    const explicit = (reasoning as any).budget_tokens ?? (reasoning as any).max_tokens;
    if (typeof explicit === 'number' && explicit > 0) return { type: 'enabled', budget_tokens: explicit };
    const effort = (reasoning as any).effort;
    if (typeof effort === 'string' && REASONING_EFFORT_BUDGET_TOKENS[effort] != null) {
      return { type: 'enabled', budget_tokens: REASONING_EFFORT_BUDGET_TOKENS[effort] };
    }
  }

  if (typeof body.reasoning_effort === 'string' && REASONING_EFFORT_BUDGET_TOKENS[body.reasoning_effort] != null) {
    return { type: 'enabled', budget_tokens: REASONING_EFFORT_BUDGET_TOKENS[body.reasoning_effort] };
  }

  return undefined;
}

const EPHEMERAL = { type: 'ephemeral' } as const;

function cacheTailBlock(message: any): void {
  if (!message) return;
  const content = message.content;
  if (typeof content === 'string') {
    if (content) message.content = [{ type: 'text', text: content, cache_control: EPHEMERAL }];
    return;
  }
  if (Array.isArray(content) && content.length) {
    const last = content[content.length - 1];
    if (last && typeof last === 'object') last.cache_control = EPHEMERAL;
  }
}

function applyPromptCaching(payload: Record<string, any>): void {
  if (typeof payload.system === 'string' && payload.system) {
    payload.system = [{ type: 'text', text: payload.system, cache_control: EPHEMERAL }];
  }
  if (Array.isArray(payload.tools) && payload.tools.length) {
    payload.tools[payload.tools.length - 1].cache_control = EPHEMERAL;
  }
  if (Array.isArray(payload.messages) && payload.messages.length) {
    cacheTailBlock(payload.messages[payload.messages.length - 1]);
  }
}

export function buildAnthropicCorePayload(body: Record<string, any>): Record<string, unknown> {
  const { system, messages } = translateMessages(body.messages ?? []);

  const explicitMaxTokens = body.max_tokens ?? body.max_completion_tokens;
  const thinking = translateThinking(body);
  const maxTokens =
    explicitMaxTokens ?? (thinking ? DEFAULT_MAX_TOKENS_WITH_THINKING : DEFAULT_MAX_TOKENS);

  const payload: Record<string, unknown> = {
    max_tokens: maxTokens,
    messages,
  };
  if (system) payload.system = system;
  // Anthropic rejects temperature/top_p entirely once extended thinking is
  // enabled ("`temperature` may only be set to 1 when thinking is enabled" —
  // top_p is rejected outright too) — a client that sets both a sampling
  // param and reasoning_effort/thinking would otherwise 400 upstream. Thinking
  // already picks its own randomness, so drop both rather than forwarding a
  // combination Anthropic never accepts.
  if (!thinking) {
    if (body.temperature != null) payload.temperature = body.temperature;
    if (body.top_p != null) payload.top_p = body.top_p;
  }
  if (body.stop != null) payload.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  const tools = translateTools(body.tools);
  if (tools) payload.tools = tools;
  const toolChoice = translateToolChoice(body.tool_choice);
  if (toolChoice) payload.tool_choice = toolChoice;

  if (thinking) {
    // Anthropic requires budget_tokens < max_tokens; clamp instead of 400ing
    // on a client-set combination that doesn't leave room for the answer.
    payload.thinking = { ...thinking, budget_tokens: Math.min(thinking.budget_tokens, Math.max(1024, maxTokens - 1024)) };
  }

  applyPromptCaching(payload);
  return payload;
}

export function buildAnthropicRequest(
  body: Record<string, any>,
  descriptor: UpstreamDescriptor,
): UpstreamRequest {
  const payload: Record<string, unknown> = {
    model: anthropicModelName(descriptor.resolvedModel || body.model),
    ...buildAnthropicCorePayload(body),
  };
  if (body.stream) payload.stream = true;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': descriptor.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (descriptor.headers) Object.assign(headers, descriptor.headers);

  return {
    url: `${trimTrailingSlash(descriptor.baseUrl)}/messages`,
    headers,
    payload,
  };
}
