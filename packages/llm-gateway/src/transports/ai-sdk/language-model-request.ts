import type {
  JSONValue,
  ModelMessage,
  ToolChoice,
  ToolSet,
} from 'ai';
import { jsonSchema, tool } from 'ai';

// AI-SDK-NATIVE ingress decoder.
//
// Parses a `POST /language-model` request — the Vercel "AI Gateway" wire
// protocol `@ai-sdk/gateway` sends — into the shape the internal pipeline needs
// to resolve candidates and drive `streamText`. This is FAR simpler than the
// OpenAI→AI-SDK conversion in request.ts: the CallOptions `prompt` is ALREADY
// an AI-SDK provider message array, so text + tool traffic needs no
// translation. The only real work is:
//   - reading the model id, spec version, and streaming flag from HEADERS (the
//     model id is in `ai-language-model-id`, NOT the body/path);
//   - normalizing v3 file parts (old `data:` URL / `file-url` / `image-url`
//     shapes) to what the provider expects;
//   - lifting `tools` into an AI-SDK `ToolSet` with no `execute` (opencode runs
//     tools, not us — identical to request.ts's toToolSet).

export const AI_GATEWAY_PROTOCOL_VERSION = '0.0.1';

// Accept BOTH LanguageModelV3 ("3") and V4 ("4") — the common parts this
// gateway serves are identical across them. Do not hard-require one.
export type LanguageModelSpecVersion = '3' | '4';

export interface LanguageModelHeaders {
  /** `ai-language-model-id` — the model id lives HERE, not in the body/path. */
  modelId: string;
  /** `ai-language-model-specification-version` — "3" or "4". */
  specVersion: LanguageModelSpecVersion;
  /** `ai-language-model-streaming` — "true"/"false". */
  streaming: boolean;
  /** `ai-gateway-protocol-version` — accepted, not hard-required. */
  protocolVersion?: string;
}

export interface DecodedLanguageModelRequest {
  headers: LanguageModelHeaders;
  /** True when any user message carries an image file part — feeds
   *  `resolveRoute({ requires: { imageInput } })`, exactly like the OpenAI
   *  path's `requestHasImage`. */
  hasImageInput: boolean;
  /** AI-SDK `streamText`/`generateText` args, ready to spread onto the call.
   *  `messages` is the converted provider prompt; `tools`/`providerOptions`
   *  are preserved from the CallOptions verbatim. */
  call: {
    system?: string;
    messages: ModelMessage[];
    tools?: ToolSet;
    toolChoice?: ToolChoice<ToolSet>;
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stopSequences?: string[];
    maxOutputTokens?: number;
    seed?: number;
    providerOptions?: Record<string, Record<string, JSONValue>>;
    /** v4 `reasoning` effort field, when present. */
    reasoning?: unknown;
    responseFormat?: unknown;
  };
  /** The raw parsed CallOptions body, for tracing/diagnostics. */
  raw: Record<string, unknown>;
}

export class LanguageModelRequestError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'LanguageModelRequestError';
  }
}

// --- header decode -------------------------------------------------------

type HeaderReader = (name: string) => string | undefined;

function toHeaderReader(headers: HeaderReader | Record<string, string | undefined>): HeaderReader {
  if (typeof headers === 'function') return headers;
  // Case-insensitive lookup over a plain object.
  const lower = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(headers)) lower.set(k.toLowerCase(), v);
  return (name: string) => lower.get(name.toLowerCase());
}

export function decodeLanguageModelHeaders(
  headers: HeaderReader | Record<string, string | undefined>,
): LanguageModelHeaders {
  const read = toHeaderReader(headers);
  const modelId = read('ai-language-model-id')?.trim();
  if (!modelId) {
    throw new LanguageModelRequestError('Missing ai-language-model-id header');
  }
  // Spec version is quoted on the wire (e.g. `"3"`). Accept quoted or bare, and
  // accept "3" or "4"; default to "4" when absent rather than rejecting — the
  // common parts are version-agnostic.
  const rawSpec = read('ai-language-model-specification-version')?.replace(/"/g, '').trim();
  const specVersion: LanguageModelSpecVersion = rawSpec === '3' ? '3' : '4';
  const streamingRaw = read('ai-language-model-streaming')?.replace(/"/g, '').trim();
  const streaming = streamingRaw !== 'false';
  const protocolVersion = read('ai-gateway-protocol-version')?.trim() || undefined;
  return { modelId, specVersion, streaming, protocolVersion };
}

// --- file-part normalization (v3 legacy shapes) --------------------------

interface DataUrl {
  mediaType: string;
  base64: string;
}

// Decode a `data:<mediaType>;base64,<payload>` URL into its parts. Returns null
// for anything that is not a data URL (a plain http(s) URL, raw base64, ...).
function parseDataUrl(value: string): DataUrl | null {
  if (!value.startsWith('data:')) return null;
  const comma = value.indexOf(',');
  if (comma === -1) return null;
  const meta = value.slice(5, comma); // between "data:" and ","
  const isBase64 = /;base64/i.test(meta);
  const mediaType = meta.split(';')[0] || 'application/octet-stream';
  const payload = value.slice(comma + 1);
  return { mediaType, base64: isBase64 ? payload : btoa(decodeURIComponent(payload)) };
}

interface NormalizedFilePart {
  type: 'file';
  mediaType: string;
  data: string | URL;
  filename?: string;
}

// Normalize any of the legacy v3 file/image shapes into an AI-SDK provider file
// part: `data` is either inline base64 (for `data:` URLs) or a URL (for remote
// references). Handles `{type:'file', data:'data:...'}`, `{type:'image',
// image:'data:...'|url}`, `{type:'image-url'|'file-url', url}`, and a bare
// `data` string.
function normalizeFilePart(part: Record<string, unknown>): NormalizedFilePart {
  const explicitMediaType =
    typeof part.mediaType === 'string'
      ? part.mediaType
      : typeof part.mimeType === 'string'
        ? (part.mimeType as string)
        : undefined;
  const filename = typeof part.filename === 'string' ? part.filename : undefined;

  // Collect the raw reference from whichever legacy field carries it.
  const rawRef =
    part.data ??
    part.image ??
    part.url ??
    (part.image_url && typeof part.image_url === 'object'
      ? (part.image_url as { url?: unknown }).url
      : undefined);

  // Already inline bytes (Uint8Array / ArrayBuffer) — pass base64 through as-is
  // is not our job here; the provider package handles binary. Only strings and
  // URLs need normalization.
  if (rawRef instanceof URL) {
    return {
      type: 'file',
      mediaType: explicitMediaType ?? 'application/octet-stream',
      data: rawRef,
      ...(filename ? { filename } : {}),
    };
  }

  if (typeof rawRef === 'string') {
    const dataUrl = parseDataUrl(rawRef);
    if (dataUrl) {
      return {
        type: 'file',
        mediaType: explicitMediaType ?? dataUrl.mediaType,
        data: dataUrl.base64,
        ...(filename ? { filename } : {}),
      };
    }
    // A remote reference → keep as a URL the provider can fetch/inline.
    if (/^https?:\/\//i.test(rawRef)) {
      return {
        type: 'file',
        mediaType: explicitMediaType ?? 'application/octet-stream',
        data: new URL(rawRef),
        ...(filename ? { filename } : {}),
      };
    }
    // Otherwise assume it is already base64.
    return {
      type: 'file',
      mediaType: explicitMediaType ?? 'application/octet-stream',
      data: rawRef,
      ...(filename ? { filename } : {}),
    };
  }

  // Fallback: pass through whatever data field exists, defaulting mediaType.
  return {
    type: 'file',
    mediaType: explicitMediaType ?? 'application/octet-stream',
    data: typeof part.data === 'string' ? part.data : '',
    ...(filename ? { filename } : {}),
  };
}

function isImageMediaType(mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith('image/');
}

// --- prompt conversion (provider messages → ModelMessage[]) --------------

interface PromptConversion {
  system?: string;
  messages: ModelMessage[];
  hasImageInput: boolean;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : '',
      )
      .join('');
  }
  return '';
}

function convertPrompt(prompt: unknown): PromptConversion {
  const messages: ModelMessage[] = [];
  let system: string | undefined;
  let hasImageInput = false;
  if (!Array.isArray(prompt)) return { messages, hasImageInput };

  for (const raw of prompt) {
    const m = raw as { role?: string; content?: unknown };
    if (m.role === 'system') {
      const text = textOfContent(m.content);
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }
    if (m.role === 'user') {
      const content = m.content;
      if (typeof content === 'string') {
        messages.push({ role: 'user', content });
        continue;
      }
      const parts: Array<Record<string, unknown>> = [];
      for (const rawPart of Array.isArray(content) ? content : []) {
        const part = rawPart as Record<string, unknown>;
        if (part.type === 'text') {
          parts.push({ type: 'text', text: String(part.text ?? '') });
        } else if (
          part.type === 'file' ||
          part.type === 'image' ||
          part.type === 'image-url' ||
          part.type === 'file-url'
        ) {
          const file = normalizeFilePart(part);
          if (isImageMediaType(file.mediaType)) hasImageInput = true;
          parts.push(file as unknown as Record<string, unknown>);
        }
      }
      messages.push({ role: 'user', content: parts as never });
      continue;
    }
    if (m.role === 'assistant') {
      const content = m.content;
      if (typeof content === 'string') {
        messages.push({ role: 'assistant', content });
        continue;
      }
      const parts: Array<Record<string, unknown>> = [];
      for (const rawPart of Array.isArray(content) ? content : []) {
        const part = rawPart as Record<string, unknown>;
        if (part.type === 'text') {
          parts.push({ type: 'text', text: String(part.text ?? '') });
        } else if (part.type === 'reasoning') {
          // Preserve the reasoning text AND its providerOptions (the Anthropic
          // signature rides here on a replayed assistant turn).
          parts.push({
            type: 'reasoning',
            text: String(part.text ?? ''),
            ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
          });
        } else if (part.type === 'tool-call') {
          parts.push({
            type: 'tool-call',
            toolCallId: String(part.toolCallId ?? ''),
            toolName: String(part.toolName ?? ''),
            input: part.input ?? {},
          });
        } else if (part.type === 'file' || part.type === 'image') {
          parts.push(normalizeFilePart(part) as unknown as Record<string, unknown>);
        }
      }
      messages.push({ role: 'assistant', content: parts as never });
      continue;
    }
    if (m.role === 'tool') {
      const content = m.content;
      const parts: Array<Record<string, unknown>> = [];
      for (const rawPart of Array.isArray(content) ? content : []) {
        const part = rawPart as Record<string, unknown>;
        if (part.type === 'tool-result') {
          parts.push({
            type: 'tool-result',
            toolCallId: String(part.toolCallId ?? ''),
            toolName: String(part.toolName ?? ''),
            // The provider tool-result `output` (`{type:'text'|'json'|...,value}`)
            // is already the AI-SDK ToolResultPart output shape — pass verbatim.
            output: part.output ?? { type: 'text', value: '' },
          });
        }
      }
      messages.push({ role: 'tool', content: parts as never });
      continue;
    }
  }

  return { system, messages, hasImageInput };
}

// --- tools ---------------------------------------------------------------

interface CallOptionsTool {
  type?: string;
  name?: string;
  description?: string;
  inputSchema?: unknown;
}

// LanguageModelV{3,4} function tools → an AI-SDK ToolSet with NO `execute`
// (identical rationale to request.ts's toToolSet: the SDK surfaces the model's
// tool call and stops; opencode executes it). Provider-defined tools (type
// !== 'function') are skipped — Phase 1 serves function tools, the only kind
// opencode sends.
function toToolSet(rawTools: unknown): ToolSet | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const raw of rawTools) {
    const t = raw as CallOptionsTool;
    if (t.type && t.type !== 'function') continue;
    if (!t.name) continue;
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema((t.inputSchema as object) ?? { type: 'object', properties: {} }),
    });
  }
  return Object.keys(set).length ? set : undefined;
}

function toToolChoice(raw: unknown): ToolChoice<ToolSet> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const type = (raw as { type?: string }).type;
  if (type === 'auto' || type === 'none' || type === 'required') return type;
  if (type === 'tool') {
    const toolName = (raw as { toolName?: string }).toolName;
    if (toolName) return { type: 'tool', toolName };
  }
  return undefined;
}

// --- top-level decode ----------------------------------------------------

export function decodeLanguageModelRequest(input: {
  headers: HeaderReader | Record<string, string | undefined>;
  body: unknown;
}): DecodedLanguageModelRequest {
  const headers = decodeLanguageModelHeaders(input.headers);
  const body =
    input.body && typeof input.body === 'object' ? (input.body as Record<string, unknown>) : {};

  const { system, messages, hasImageInput } = convertPrompt(body.prompt);
  const tools = toToolSet(body.tools);
  const toolChoice = tools ? toToolChoice(body.toolChoice) : undefined;

  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

  const stop = body.stopSequences;
  const stopSequences = Array.isArray(stop) ? (stop as string[]) : undefined;

  return {
    headers,
    hasImageInput,
    call: {
      system,
      messages,
      tools,
      toolChoice,
      temperature: num(body.temperature),
      topP: num(body.topP),
      topK: num(body.topK),
      frequencyPenalty: num(body.frequencyPenalty),
      presencePenalty: num(body.presencePenalty),
      stopSequences,
      maxOutputTokens: num(body.maxOutputTokens),
      seed: num(body.seed),
      providerOptions: body.providerOptions as
        | Record<string, Record<string, JSONValue>>
        | undefined,
      reasoning: body.reasoning,
      responseFormat: body.responseFormat,
    },
    raw: body,
  };
}
