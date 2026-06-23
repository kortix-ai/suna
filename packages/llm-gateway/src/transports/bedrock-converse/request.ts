import type { UpstreamDescriptor } from '../../domain';
import type { UpstreamRequest } from '../openai-compat';

const DEFAULT_MAX_TOKENS = 4096;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
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

// OpenAI user content → Converse content blocks (text + inline base64 images).
function userContent(content: unknown): any[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: textOf(content) }];
  const out: any[] = [];
  for (const part of content as any[]) {
    if (part?.type === 'text') {
      out.push({ text: part.text ?? '' });
    } else if (part?.type === 'image_url') {
      const url: string = part.image_url?.url ?? '';
      if (url.startsWith('data:')) {
        const comma = url.indexOf(',');
        const mediaType = url.slice(5, comma).split(';')[0] || 'image/png';
        const format = (mediaType.split('/')[1] || 'png').toLowerCase();
        out.push({ image: { format, source: { bytes: url.slice(comma + 1) } } });
      }
      // Remote image URLs aren't supported by Converse (needs bytes) — dropped.
    }
  }
  return out.length ? out : [{ text: '' }];
}

// OpenAI messages → Converse messages + system blocks. Converse has only
// user/assistant roles; tool results go in a user message (same as Anthropic).
function translate(messages: any[]): { system?: any[]; messages: any[] } {
  const system: any[] = [];
  const out: any[] = [];
  for (const m of messages ?? []) {
    if (m.role === 'system') {
      const t = textOf(m.content);
      if (t) system.push({ text: t });
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: m.tool_call_id,
              content: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
            },
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const content: any[] = [];
      const text = textOf(m.content);
      if (text) content.push({ text });
      for (const tc of m.tool_calls ?? []) {
        content.push({ toolUse: { toolUseId: tc.id, name: tc.function?.name, input: safeParse(tc.function?.arguments) } });
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ text: '' }] });
      continue;
    }
    out.push({ role: 'user', content: userContent(m.content) });
  }
  return { system: system.length ? system : undefined, messages: out };
}

function toolConfig(body: Record<string, any>): Record<string, unknown> | undefined {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const specs = tools
    .filter((t) => t?.function?.name)
    .map((t) => ({
      toolSpec: {
        name: t.function.name,
        description: t.function.description ?? '',
        inputSchema: { json: t.function.parameters ?? { type: 'object', properties: {} } },
      },
    }));
  if (!specs.length) return undefined;
  const cfg: Record<string, unknown> = { tools: specs };
  const tc = body.tool_choice;
  // Only set toolChoice when forcing — many models reject an explicit {auto:{}}.
  if (tc === 'required') cfg.toolChoice = { any: {} };
  else if (typeof tc === 'object' && tc?.function?.name) cfg.toolChoice = { tool: { name: tc.function.name } };
  return cfg;
}

export function buildBedrockConverseRequest(
  body: Record<string, any>,
  descriptor: UpstreamDescriptor,
): UpstreamRequest {
  const { system, messages } = translate(body.messages ?? []);

  const inferenceConfig: Record<string, unknown> = {
    maxTokens: body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
  };
  if (body.temperature != null) inferenceConfig.temperature = body.temperature;
  if (body.top_p != null) inferenceConfig.topP = body.top_p;
  if (body.stop != null) inferenceConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  const payload: Record<string, unknown> = { messages, inferenceConfig };
  if (system) payload.system = system;
  const tc = toolConfig(body);
  if (tc) payload.toolConfig = tc;

  const modelId = descriptor.resolvedModel || String(body.model ?? '');
  const action = body.stream === true ? 'converse-stream' : 'converse';

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${descriptor.apiKey}`,
  };
  if (descriptor.headers) Object.assign(headers, descriptor.headers);

  return {
    url: `${trimTrailingSlash(descriptor.baseUrl)}/model/${encodeURIComponent(modelId)}/${action}`,
    headers,
    payload,
  };
}
