import type { UpstreamRequest } from '../openai-compat';
import type { UpstreamDescriptor } from '../../domain';

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

function toolsToResponses(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((tool) => {
    const fn = (tool as Json)?.function as Json | undefined;
    if ((tool as Json)?.type === 'function' && fn) {
      return { type: 'function', name: fn.name, description: fn.description, parameters: fn.parameters };
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

    input.push({ role, content: contentToText(message.content) });
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
