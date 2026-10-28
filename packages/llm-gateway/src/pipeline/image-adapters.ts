import type { TokenCounts, UpstreamDescriptor } from '../domain';
import { type FetchImpl, callUpstream } from '../http';
import { parseUpstreamErrorBody } from '../http/parse-upstream-error';
import { trimTrailingSlash } from '../transports/ai-sdk/model';
import { isGenuineOpenAiUpstream } from '../transports/route-kind';
import { extractUsageFromJson } from '../usage';

export const ASPECT_RATIOS = ['auto', '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** One image request in the gateway's own contract (U-D1), already validated. */
export interface ImageInput {
  operation: 'generations' | 'edits';
  prompt: string;
  aspectRatio?: AspectRatio;
  quality?: string;
  background?: string;
  /** Reference image URLs (data URLs from the tool). Edits only. */
  images?: string[];
}

export interface ImageContext {
  fetchImpl: FetchImpl;
  signal: AbortSignal;
  requestId: string;
}

export interface ImageResult {
  ok: true;
  b64: string;
  mimeType: string;
  size?: string;
  created?: number;
  usage: TokenCounts;
  /** The provider's own price for this call, when it reports one. */
  upstreamCostUsd?: number;
  headers: Headers;
}

/** The upstream answered without an image. `status` is the upstream's, or 502 for an unreadable 200. */
export interface ImageFailure {
  ok: false;
  status: number;
  message: string;
  code?: string | number;
  /** The upstream's raw error text, for the server log only. */
  detail: string;
  headers: Headers;
}

export type ImageAttempt = ImageResult | ImageFailure;
export type ImageAdapter = (descriptor: UpstreamDescriptor, input: ImageInput, ctx: ImageContext) => Promise<ImageAttempt>;

type Parsed = Omit<ImageResult, 'ok' | 'headers'>;

/** The fields read from each protocol's answer (live probe, 2026-10-28). */
interface ImagesApiAnswer {
  created?: unknown;
  data?: { b64_json?: unknown; mime_type?: unknown }[];
  output_format?: unknown;
  size?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown; cost_in_usd_ticks?: unknown };
}
interface InlineData { mimeType?: unknown; data?: unknown }
interface GeminiAnswer {
  candidates?: { content?: { parts?: { inlineData?: InlineData; inline_data?: InlineData }[] } }[];
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
}
interface ChatImageAnswer {
  choices?: { message?: { images?: { image_url?: { url?: unknown } }[] } }[];
}

/** Token counts as the chat path settles them; a missing or malformed count is 0. */
function tokens(prompt: unknown, completion: unknown): TokenCounts {
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  return { promptTokens: count(prompt), completionTokens: count(completion), cachedTokens: 0, cacheWriteTokens: 0 };
}

const SIZE_FOR: Record<AspectRatio, string> = {
  auto: 'auto',
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '4:3': '1536x1024',
  '16:9': '1536x1024',
  '2:3': '1024x1536',
  '3:4': '1024x1536',
  '9:16': '1024x1536',
};

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** `data:<mime>;base64,<b64>` → its parts; anything else (an https URL) → null. */
function dataUrl(url: string): { mimeType: string; b64: string } | null {
  const head = /^data:([^;,]+);base64,/.exec(url.slice(0, 128));
  return head ? { mimeType: head[1], b64: url.slice(head[0].length) } : null;
}

/** Bearer auth and descriptor headers, as the chat path sends them (http/call-upstream.ts). */
function bearerHeaders(descriptor: UpstreamDescriptor, requestId: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!descriptor.omitAuthorization) headers.authorization = `Bearer ${descriptor.apiKey}`;
  if (descriptor.appName) headers['x-title'] = descriptor.appName;
  if (descriptor.appReferer) headers['http-referer'] = descriptor.appReferer;
  Object.assign(headers, descriptor.headers);
  headers['x-request-id'] = requestId;
  return headers;
}

/**
 * Reads one upstream answer. An error body is small and read as text; a
 * success body (up to ~5 MB of base64) is parsed once, and only the extracted
 * image string outlives this frame.
 */
async function answer<T>(response: Response, read: (body: T) => Parsed | null): Promise<ImageAttempt> {
  const { headers, status } = response;
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const { message, code } = parseUpstreamErrorBody(detail, '');
    return { ok: false, status, message, code, detail: detail.slice(0, 500), headers };
  }
  const body: unknown = await response.json().catch(() => null);
  const parsed = body && typeof body === 'object' ? read(body as T) : null;
  if (!parsed?.b64) return { ok: false, status: 502, code: 'no_image', message: '', detail: `${status} without an image`, headers };
  return { ok: true, ...parsed, headers };
}

/** OpenAI Images API: ChatGPT plans, api.openai.com, api.x.ai. */
const openaiImages: ImageAdapter = async (descriptor, input, ctx) => {
  const model = descriptor.resolvedModel ?? '';
  const xai = hostname(descriptor.baseUrl) === 'api.x.ai';
  const body: Record<string, unknown> = { model, prompt: input.prompt, n: 1 };
  // gpt-image models reject `response_format` and always answer base64.
  if (!/^(gpt-image|chatgpt-image)/.test(model)) body.response_format = 'b64_json';
  // xAI gets only the fields its live probe accepted.
  if (!xai) {
    if (input.aspectRatio) body.size = SIZE_FOR[input.aspectRatio];
    if (input.quality) body.quality = input.quality;
    if (input.background) body.background = input.background;
  }
  if (input.images) body.images = input.images.map((image_url) => ({ image_url }));
  const response = await ctx.fetchImpl(`${trimTrailingSlash(descriptor.baseUrl)}/images/${input.operation}`, {
    method: 'POST',
    headers: bearerHeaders(descriptor, ctx.requestId),
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
  return answer<ImagesApiAnswer>(response, (data) => {
    const image = data.data?.[0];
    if (typeof image?.b64_json !== 'string') return null;
    const usage = data.usage ?? {};
    return {
      b64: image.b64_json,
      mimeType: typeof image.mime_type === 'string' ? image.mime_type : `image/${typeof data.output_format === 'string' ? data.output_format : 'png'}`,
      size: typeof data.size === 'string' ? data.size : undefined,
      created: typeof data.created === 'number' ? data.created : undefined,
      usage: tokens(usage.input_tokens, usage.output_tokens),
      // xAI prices each call in ticks: 1e10 ticks = 1 USD.
      upstreamCostUsd: typeof usage.cost_in_usd_ticks === 'number' ? usage.cost_in_usd_ticks / 1e10 : undefined,
    };
  });
};

/** Gemini native `generateContent`. The catalog stores the OpenAI-compatible base `…/v1beta/openai`. */
const gemini: ImageAdapter = async (descriptor, input, ctx) => {
  const parts: Record<string, unknown>[] = [{ text: input.prompt }];
  for (const url of input.images ?? []) {
    const inline = dataUrl(url);
    if (!inline) {
      const message = 'Gemini accepts reference images only as base64 data URLs.';
      return { ok: false, status: 400, message, detail: message, headers: new Headers() };
    }
    parts.push({ inlineData: { mimeType: inline.mimeType, data: inline.b64 } });
  }
  const aspectRatio = input.aspectRatio && input.aspectRatio !== 'auto' ? input.aspectRatio : undefined;
  const base = trimTrailingSlash(descriptor.baseUrl).replace(/\/openai$/, '');
  const model = encodeURIComponent(descriptor.resolvedModel ?? '');
  const response = await ctx.fetchImpl(`${base}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': descriptor.apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE'], ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}) },
    }),
    signal: ctx.signal,
  });
  return answer<GeminiAnswer>(response, (data) => {
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.map((part) => part?.inlineData ?? part?.inline_data).find((part) => typeof part?.data === 'string');
    if (typeof inline?.data !== 'string') return null;
    const usage = data.usageMetadata ?? {};
    return {
      b64: inline.data,
      mimeType: typeof inline.mimeType === 'string' ? inline.mimeType : 'image/png',
      usage: tokens(usage.promptTokenCount, usage.candidatesTokenCount),
    };
  });
};

/** OpenAI-compatible chat completions with image output: OpenRouter, managed, custom providers. */
const chatImage: ImageAdapter = async (descriptor, input, ctx) => {
  const content = input.images?.length
    ? [{ type: 'text', text: input.prompt }, ...input.images.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : input.prompt;
  const aspectRatio = input.aspectRatio && input.aspectRatio !== 'auto' ? input.aspectRatio : undefined;
  // callUpstream posts `/chat/completions` with the chat path's headers and
  // pins a user-supplied base URL to a public address (descriptor.egress).
  const response = await callUpstream(
    {
      messages: [{ role: 'user', content }],
      modalities: ['image', 'text'],
      ...(aspectRatio ? { image_config: { aspect_ratio: aspectRatio } } : {}),
    },
    descriptor,
    { fetchImpl: ctx.fetchImpl, signal: ctx.signal, requestId: ctx.requestId },
  );
  return answer<ChatImageAnswer>(response, (data) => {
    const url = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    const image = typeof url === 'string' ? dataUrl(url) : null;
    if (!image) return null;
    const usage = extractUsageFromJson(data);
    return {
      b64: image.b64,
      mimeType: image.mimeType,
      usage: tokens(usage.promptTokens, usage.completionTokens),
      // OpenRouter and the managed upstream report their price as `usage.cost`.
      upstreamCostUsd: usage.upstreamCostHint,
    };
  });
};

/**
 * The protocol a descriptor speaks for images, chosen from the descriptor
 * (provider, base host, kind), never from the model name. Null: this
 * descriptor cannot generate images (Anthropic, Bedrock, a Responses-only API).
 */
export function imageAdapterFor(descriptor: UpstreamDescriptor): ImageAdapter | null {
  const host = hostname(descriptor.baseUrl);
  if (descriptor.provider === 'openai-codex' || isGenuineOpenAiUpstream(descriptor.baseUrl) || host === 'api.x.ai') {
    return openaiImages;
  }
  if (host === 'generativelanguage.googleapis.com') return gemini;
  if (descriptor.kind === 'openai-compat' || descriptor.kind === 'custom') return chatImage;
  return null;
}
