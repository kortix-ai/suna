import type { UpstreamDescriptor } from '../../domain';
import type { UpstreamRequest } from '../openai-compat';

type Json = Record<string, unknown>;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object') {
      const text = (part as Json).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

// User content for the Responses API. Preserves images: OpenAI chat `image_url`
// parts become Responses `input_image` parts (base64 data-URLs and remote URLs
// both pass through). Plain string / text-only collapses to a string.
function toResponsesUserContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return contentToText(content);
  const parts: Json[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as Json;
    if (part.type === 'image_url') {
      const url = (part.image_url as Json | undefined)?.url;
      if (typeof url === 'string' && url) parts.push({ type: 'input_image', image_url: url });
    } else if (typeof part.text === 'string') {
      parts.push({ type: 'input_text', text: part.text });
    }
  }
  if (!parts.length) return '';
  // Text-only → a plain string keeps the payload minimal.
  return parts.every((p) => p.type === 'input_text') ? parts.map((p) => p.text).join('') : parts;
}

function toolsToResponses(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((tool) => {
    const fn = (tool as Json)?.function as Json | undefined;
    if ((tool as Json)?.type === 'function' && fn) {
      return {
        type: 'function',
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      };
    }
    return tool;
  });
}

function reasoningFromBody(body: Json): Json | undefined {
  if (body.reasoning && typeof body.reasoning === 'object') return body.reasoning as Json;
  if (typeof body.reasoning_effort === 'string') return { effort: body.reasoning_effort };
  return undefined;
}

function messagesToInput(messages: unknown[]): { instructions: string; input: unknown[] } {
  const instructions: string[] = [];
  const input: unknown[] = [];

  for (const raw of messages) {
    const message = raw as Json;
    const role = message.role;

    if (role === 'system' || role === 'developer') {
      instructions.push(contentToText(message.content));
      continue;
    }

    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: contentToText(message.content),
      });
      continue;
    }

    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      for (const call of message.tool_calls as Json[]) {
        const fn = call.function as Json | undefined;
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: fn?.name,
          arguments: typeof fn?.arguments === 'string' ? fn.arguments : '',
        });
      }
      const text = contentToText(message.content);
      if (text) input.push({ role: 'assistant', content: text });
      continue;
    }

    // User turns keep images (input_image); other roles stay text.
    input.push({
      role,
      content:
        role === 'user' ? toResponsesUserContent(message.content) : contentToText(message.content),
    });
  }

  return { instructions: instructions.filter(Boolean).join('\n\n'), input };
}

export function chatToResponses(body: Json, descriptor: UpstreamDescriptor): Json {
  const { instructions, input } = messagesToInput(asArray(body.messages));

  const payload: Json = {
    model: descriptor.resolvedModel || body.model,
    input,
    stream: body.stream === true,
    store: false,
  };

  if (instructions) payload.instructions = instructions;
  const tools = toolsToResponses(body.tools);
  if (tools) payload.tools = tools;
  if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice;
  const reasoning = reasoningFromBody(body);
  if (reasoning) payload.reasoning = reasoning;

  return payload;
}

export function buildResponsesRequest(body: Json, descriptor: UpstreamDescriptor): UpstreamRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${descriptor.apiKey}`,
    accept: 'text/event-stream',
  };
  if (descriptor.headers) Object.assign(headers, descriptor.headers);

  return {
    url: `${trimTrailingSlash(descriptor.baseUrl)}/responses`,
    payload: chatToResponses(body, descriptor),
    headers,
  };
}
