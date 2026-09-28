import { type ModelMessage, type ToolChoice, type ToolSet, jsonSchema, tool } from 'ai';

function safeParseJson(value: unknown): unknown {
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
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : '',
      )
      .join('');
  }
  return '';
}

// Bedrock's Converse API (and the Anthropic Messages API) reject any message
// whose content is empty or whitespace-only: "The content field in the Message
// object at messages.N is empty." Such messages reach us mid-history — most
// often an assistant turn from an earlier empty upstream completion that the
// client persisted and replayed. Backfill a
// minimal non-whitespace placeholder so the message survives the round-trip
// without dropping it (dropping would collapse the user/assistant alternation
// the provider also depends on).
const EMPTY_CONTENT_PLACEHOLDER = '(no content)';

// Images travel as AI SDK `file` parts (the SDK itself rewrites `image` parts
// to `file` parts and flags `image` as deprecated). `mediaType` is the full
// IANA type from the data URL, or the top-level `image` segment when the URL
// omits it — providers resolve the subtype from the base64 signature.
type InlineImagePart = {
  type: 'file';
  data: { type: 'data'; data: string } | { type: 'url'; url: URL };
  mediaType: string;
};
type UserContentPart = { type: 'text'; text: string } | InlineImagePart;

// A user message is "empty" for Bedrock unless it carries an image or at least
// one non-whitespace text part.
function nonEmptyUserContent(content: string | UserContentPart[]): string | UserContentPart[] {
  if (typeof content === 'string') return content.trim() ? content : EMPTY_CONTENT_PLACEHOLDER;
  const hasImage = content.some((p) => p.type === 'file');
  const hasText = content.some((p) => p.type === 'text' && p.text.trim().length > 0);
  return hasImage || hasText ? content : EMPTY_CONTENT_PLACEHOLDER;
}

// Translate an OpenAI `image_url` into the AI SDK image part WITHOUT copying
// or decoding the image bytes.
//
// A `data:` URL is handed over as tagged inline data `{type:'data', data:
// <base64>}` plus its media type. The AI SDK's `convertToLanguageModelV4FilePart`
// returns tagged data as-is, and both `@ai-sdk/anthropic` and
// `@ai-sdk/amazon-bedrock` serialize a base64 STRING through
// `convertToBase64(value)`, which is the identity for strings. The base64
// substring therefore travels from the parsed request body to the provider
// payload with zero decode and zero re-encode.
//
// The previous implementation decoded to `Uint8Array` via
// `atob(raw).split('').map(...)` — one JS string per byte — which measured at
// ~13x the base64 length in resident memory per image (89 MB for a 6.7 MB
// image) and then had provider-utils re-encode the bytes through a
// `String.fromCodePoint` concat loop. A 28 MB, 40-screenshot request went
// through that path and OOM-killed a 512 MiB gateway (SampleCo, 2026-08-22).
//
// Bedrock's Converse API still needs inline data rather than a URL reference
// (`UnsupportedFunctionalityError: File URL data`), which the tagged inline
// form satisfies. A non-data URL stays a `URL`.
export function imageContentFromUrl(url: string): InlineImagePart {
  const remote = (): InlineImagePart => ({
    type: 'file',
    data: { type: 'url', url: new URL(url) },
    mediaType: 'image',
  });
  if (!url.startsWith('data:')) return remote();
  const comma = url.indexOf(',');
  if (comma === -1) return remote();
  const header = url.slice(5, comma); // "<mediaType>[;base64]"
  if (!header.toLowerCase().includes(';base64')) return remote();
  const semicolon = header.indexOf(';');
  const mediaType = (semicolon === -1 ? header : header.slice(0, semicolon)).trim();
  return {
    type: 'file',
    data: { type: 'data', data: url.slice(comma + 1) },
    mediaType: mediaType || 'image',
  };
}

function translateUserContent(content: unknown): string | UserContentPart[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textOf(content);
  const parts: UserContentPart[] = [];
  for (const raw of content) {
    const part = raw as { type?: string; text?: string; image_url?: { url?: string } };
    if (part?.type === 'text') parts.push({ type: 'text', text: String(part.text ?? '') });
    else if (part?.type === 'image_url' && part.image_url?.url) {
      parts.push(imageContentFromUrl(part.image_url.url));
    }
  }
  return parts.length ? parts : textOf(content);
}

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

// Bedrock's Converse API and the Anthropic Messages API reject a tool_use block
// that has no matching tool_result (and a tool_result with no matching
// tool_use): "tool_use ids were found without tool_result blocks". This happens
// when a turn is cancelled mid-tool-call and the client replays the
// half-finished pair in history — which wedges the whole conversation exactly
// like an empty message does. Drop the unmatched side so the request stays
// well-formed. OpenAI is stricter still (a tool message must follow tool_calls),
// so repairing unconditionally only ever makes a request MORE valid. Role
// alternation / consecutive-role merging is intentionally NOT done here: the
// @ai-sdk/anthropic and @ai-sdk/amazon-bedrock provider packages already coalesce
// that when they serialize ModelMessage[] to the provider wire format.
function repairToolPairing(messages: ModelMessage[]): ModelMessage[] {
  const resultIds = new Set<string>();
  const callIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === 'tool-result') resultIds.add(p.toolCallId);
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === 'tool-call') callIds.add(p.toolCallId);
    }
  }
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const kept = m.content.filter((p) => p.type !== 'tool-call' || resultIds.has(p.toolCallId));
      if (kept.length !== m.content.length) {
        out.push({ ...m, content: kept.length ? kept : EMPTY_CONTENT_PLACEHOLDER });
        continue;
      }
    } else if (m.role === 'tool' && Array.isArray(m.content)) {
      const kept = m.content.filter((p) => p.type !== 'tool-result' || callIds.has(p.toolCallId));
      if (kept.length === 0) continue; // whole tool message was orphaned — drop it
      if (kept.length !== m.content.length) {
        out.push({ ...m, content: kept });
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

// A conversation must end on a user/tool turn. A TRAILING ASSISTANT message (a
// "prefill") wedges strict backends across the board — Bedrock/Anthropic
// reasoning Claude 400s ("This model does not support assistant message prefill.
// The conversation must end with a user message.") and the ChatGPT-Codex
// Responses backend returns an empty 200 stream (surfacing as empty_completion).
// It reaches the gateway when a turn is cancelled mid-generation and the client
// replays the half-finished assistant turn in history — the same replayed-partial
// failure mode `repairToolPairing` and the empty-content backfill already repair.
// Drop the trailing assistant turn(s) so the request ends on a user/tool message.
// Applied UNCONDITIONALLY in toModelMessages, like repairToolPairing: it only ever
// makes a request MORE valid (no provider requires a trailing assistant, and agent
// flows never intend one). Pure + non-mutating. Never strips to empty (an
// all-assistant history is degenerate — leave it for the upstream to reject).
function stripTrailingAssistantPrefill(messages: ModelMessage[]): ModelMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1].role === 'assistant') end--;
  if (end === messages.length || end === 0) return messages;
  return messages.slice(0, end);
}

// OpenAI chat.completions messages → AI SDK ModelMessage[]. System messages are
// hoisted into `system` (kept separate so provider prompt-caching works). The
// role/tool-call/tool-result shape mirrors what the native transports build, but
// in the neutral AI-SDK core format the provider package then re-serializes.
// Two provider-safety normalizations run inline so a malformed history can never
// wedge a strict provider (Bedrock/Anthropic): empty/whitespace content is
// backfilled with a placeholder (per role), and orphaned tool calls/results are
// repaired via repairToolPairing before the messages are returned.
export function toModelMessages(rawMessages: unknown): {
  system?: string;
  messages: ModelMessage[];
} {
  const messages = Array.isArray(rawMessages) ? rawMessages : [];
  const systemParts: string[] = [];
  const out: ModelMessage[] = [];

  for (const raw of messages) {
    const m = raw as {
      role?: string;
      content?: unknown;
      tool_calls?: OpenAiToolCall[];
      tool_call_id?: string;
      name?: string;
    };
    if (m.role === 'system' || m.role === 'developer') {
      systemParts.push(textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.tool_call_id ?? '',
            toolName: m.name ?? '',
            output: {
              type: 'text',
              value:
                (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')) ||
                EMPTY_CONTENT_PLACEHOLDER,
            },
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = [];
      const text = textOf(m.content);
      if (text) parts.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        parts.push({
          type: 'tool-call',
          toolCallId: tc.id ?? '',
          toolName: tc.function?.name ?? '',
          input: safeParseJson(tc.function?.arguments),
        });
      }
      out.push({
        role: 'assistant',
        content: parts.length ? parts : EMPTY_CONTENT_PLACEHOLDER,
      });
      continue;
    }
    out.push({ role: 'user', content: nonEmptyUserContent(translateUserContent(m.content)) });
  }

  return {
    system: systemParts.filter(Boolean).join('\n\n') || undefined,
    messages: stripTrailingAssistantPrefill(repairToolPairing(out)),
  };
}

// OpenAI `tools` → an AI SDK ToolSet with NO `execute`. Without an implementation the
// SDK surfaces the model's tool call in the stream and stops the step (it never
// tries to run the tool), which is exactly the relay-to-client behaviour the
// gateway needs — opencode executes tools, not us.
export function toToolSet(rawTools: unknown): ToolSet | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const raw of rawTools) {
    const fn = (raw as { function?: { name?: string; description?: string; parameters?: unknown } })
      .function;
    if (!fn?.name) continue;
    set[fn.name] = tool({
      description: fn.description,
      inputSchema: jsonSchema((fn.parameters as object) ?? { type: 'object', properties: {} }),
    });
  }
  return Object.keys(set).length ? set : undefined;
}

export function toToolChoice(raw: unknown): ToolChoice<ToolSet> | undefined {
  if (raw === 'required') return 'required';
  if (raw === 'auto') return 'auto';
  if (raw === 'none') return 'none';
  if (raw && typeof raw === 'object') {
    const name = (raw as { function?: { name?: string } }).function?.name;
    if (name) return { type: 'tool', toolName: name };
  }
  return undefined;
}
