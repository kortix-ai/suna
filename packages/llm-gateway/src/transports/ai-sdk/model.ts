import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { UpstreamDescriptor } from '../../domain';
import { isGenuineOpenAiUpstream } from '../route-kind';

// Every AI SDK provider factory (createOpenAI/createAnthropic/
// createAmazonBedrock) accepts an optional `fetch`
// override of exactly this call shape (their own `FetchFunction` type,
// re-declared here rather than imported from the transitive
// `@ai-sdk/provider-utils` package this workspace doesn't depend on directly,
// and deliberately NOT `typeof globalThis.fetch` — Bun's ambient fetch type
// carries extra members like `preconnect` a plain adapter function can't
// satisfy) — used to inject a test double (see call-upstream.ts's
// `fetchImpl`/CallUpstreamOptions) or a future production middleware
// (request logging, a proxy) without any provider package needing its own
// bespoke escape hatch.
export type AiSdkFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Which AI SDK provider package a descriptor maps to. Prefer the models.dev
// `npm` field (verbatim from the live catalog, #4893); fall back to the transport
// `kind` so a descriptor that predates npm threading still resolves correctly.
//
// Only three transport kinds ever reach the AI SDK engine: `anthropic`,
// `bedrock`, and `openai-responses` (http/call-upstream.ts sends every
// `openai-compat`/`custom` request to the provider directly). So the openai
// family here is always the Responses API.
export type AiSdkFamily = 'openai' | 'anthropic' | 'bedrock';

const OPENAI_NPM = '@ai-sdk/openai';
const ANTHROPIC_NPM = '@ai-sdk/anthropic';
const BEDROCK_NPM = '@ai-sdk/amazon-bedrock';

// Codex descriptors (apps/api's descriptors.ts `codexDescriptor`) never carry a
// models.dev `npm` field — they're built by hand for the ChatGPT OAuth backend,
// not resolved from the catalog — so they're identified by shape instead:
// `kind: 'openai-responses'` (nothing else uses that kind) or, redundantly,
// `provider: 'openai-codex'`. Either is sufficient on its own; checking both
// costs nothing and survives either field changing independently.
export function isCodexDescriptor(descriptor: UpstreamDescriptor): boolean {
  return descriptor.provider === 'openai-codex' || descriptor.kind === 'openai-responses';
}

export function aiSdkFamilyFor(descriptor: UpstreamDescriptor): AiSdkFamily {
  const npm = descriptor.npm;
  if (npm === OPENAI_NPM) return 'openai';
  if (npm === ANTHROPIC_NPM) return 'anthropic';
  if (npm === BEDROCK_NPM) return 'bedrock';
  // Codex speaks the same OpenAI Responses API as genuine OpenAI.
  if (isCodexDescriptor(descriptor)) return 'openai';
  // A genuine api.openai.com descriptor that predates (or is missing) npm
  // threading must still resolve to the real `@ai-sdk/openai` package. Mirrors
  // the SAME `isGenuineOpenAiUpstream`/`descriptor.provider === 'openai'`
  // signal `resolveTransportKind` keys off of, so the routing decision and the
  // provider-package choice can never disagree.
  if (descriptor.provider === 'openai' || isGenuineOpenAiUpstream(descriptor.baseUrl)) {
    return 'openai';
  }
  switch (descriptor.kind) {
    case 'anthropic':
      return 'anthropic';
    case 'bedrock':
      return 'bedrock';
    default:
      throw new Error(
        `no AI SDK family for ${descriptor.provider} (${descriptor.kind}): OpenAI-compatible upstreams are called directly`,
      );
  }
}

// Strip trailing '/' in linear time. The idiomatic regex form
// (`url.replace(/\/+$/, '')`) is a polynomial ReDoS on adversarial inputs
// with many repeated slashes (CodeQL `js/polynomial-redos`, high severity,
// alert #4731). `descriptor.baseUrl` comes from operator/catalog config, so
// real exploitability is low — but the call sits on a hot request path, and
// the linear form is strictly safer with no downside. Mirrors the
// `stripTrailingSlashes` helper in packages/sdk/src/platform/strings.ts.
// Exported for direct unit testing.
export function trimTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === url.length ? url : url.slice(0, end);
}

// Anthropic's REST API rejects models.dev's dotted model-id convention
// outright: `{"type":"error","error":{"type":"not_found_error","message":
// "model: claude-haiku-4.5"}}` — confirmed live 2026-07-17 (a dev request and
// 8 streaming-haiku siblings all 502 this exact way; candidates_tried:
// ["anthropic"], attempts: 0 — the direct-Anthropic candidate never even gets
// a real turn in). Anthropic only recognizes the
// dash form ("claude-haiku-4-5", which itself resolves server-side to the
// dated "claude-haiku-4-5-20251001") — verified live against both forms. The
// native anthropic transport already carries this exact translation
// (transports/anthropic/request.ts's `anthropicModelName`); mirrored here
// because the AI-SDK engine builds its own LanguageModel straight from the
// catalog's resolvedModel and never goes through that transport.
function anthropicModelName(model: string): string {
  return model.replace(/(\d)\.(\d)/g, '$1-$2');
}

// Amazon Nova's Bedrock Converse API hard-rejects (400) any call whose max
// output tokens exceeds the model's own ceiling instead of silently clamping
// it — confirmed live 2026-07-17 against Nova Micro: "The maximum tokens you
// requested exceeds the model limit of 10000. Try again with a maximum
// tokens value that is lower than 10000." A client/agent framework's generic
// default max_tokens (commonly tens of thousands, sized for Claude-class
// context) then 400s/502s EVERY call to a small Nova model, deterministically
// breaking a multi-turn tool loop before it can complete a single round trip
// (a dev request and 7 streaming siblings, all "amazon-bedrock/
// us.amazon.nova-micro-v1:0"). 10000 is Nova Micro's own live-confirmed
// ceiling, used as a conservative shared cap for the whole Nova family —
// Lite/Pro are documented to allow at least as much, never less — rather than
// a per-variant table that needs upkeep as AWS ships new Nova models. Only
// ever LOWERS an oversized request; a caller that already asked for less is
// untouched.
const NOVA_MAX_OUTPUT_TOKENS = 10_000;

function isNovaModel(resolvedModel: string | undefined): boolean {
  return /amazon\.nova-/i.test(resolvedModel ?? '');
}

export function clampMaxOutputTokensForBedrock(
  maxOutputTokens: number | undefined,
  family: AiSdkFamily,
  resolvedModel: string | undefined,
): number | undefined {
  if (family !== 'bedrock' || maxOutputTokens === undefined) return maxOutputTokens;
  if (!isNovaModel(resolvedModel)) return maxOutputTokens;
  return Math.min(maxOutputTokens, NOVA_MAX_OUTPUT_TOKENS);
}

// Build the AI SDK language model for this descriptor. The provider package owns
// every provider-specific wire quirk (endpoint shape, param names, tool schema
// translation, prompt caching, SSE decoding) — we only supply credentials, base
// URL, and the resolved model id.
//
// `opts.fetch` overrides the HTTP call every provider package makes
// internally — threaded from `callUpstream`'s own `fetchImpl` (see
// http/call-upstream.ts and ai-sdk/index.ts's `callUpstreamViaAiSdk`) so a
// caller providing a custom fetch (production middleware, or a test double)
// gets it honored on the SOLE dispatch path exactly like the retired native
// transport's `fetchImpl` did. `opts.extraHeaders` merges on top of
// `descriptor.headers` — used to carry the `x-kortix-request-id` correlation
// header the native transport used to attach in `callUpstream` itself.
export function resolveAiModel(
  descriptor: UpstreamDescriptor,
  opts: { fetch?: AiSdkFetch; extraHeaders?: Record<string, string> } = {},
): LanguageModel {
  const modelId = descriptor.resolvedModel || '';
  const baseURL = descriptor.baseUrl ? trimTrailingSlash(descriptor.baseUrl) : undefined;
  const headers = { ...descriptor.headers, ...opts.extraHeaders };
  // Each provider factory's `fetch` prop is typed as its own `FetchFunction`
  // (`typeof globalThis.fetch`) which, under this workspace's Bun ambient
  // types, requires a `preconnect` member no plain adapter function has.
  // `AiSdkFetch`'s narrower call-shape type is what this module's own API
  // surface exposes (see its doc comment) — cast at the one point it crosses
  // into the SDK's stricter ambient type; every provider here only ever
  // *calls* `fetch(input, init)`, never touches `.preconnect`.
  const fetch = opts.fetch as typeof globalThis.fetch | undefined;
  const family = aiSdkFamilyFor(descriptor);

  switch (family) {
    case 'openai': {
      const provider = createOpenAI({ baseURL, apiKey: descriptor.apiKey, headers, fetch });
      // Only the openai-responses transport kind reaches here: Codex, and a
      // genuine OpenAI reasoning model with function tools and a live effort,
      // which /v1/chat/completions refuses (see route-kind.ts).
      return provider.responses(modelId);
    }
    case 'anthropic': {
      const provider = createAnthropic({ baseURL, apiKey: descriptor.apiKey, headers, fetch });
      return provider(anthropicModelName(modelId));
    }
    case 'bedrock': {
      // SampleCo + the enterprise appliance authenticate with a long-lived bearer
      // token (apiKey), not SigV4 — it takes precedence over AWS credentials in the
      // provider. Region is required by the SDK for the endpoint host.
      const provider = createAmazonBedrock({
        baseURL,
        apiKey: descriptor.apiKey,
        region: descriptor.region || process.env.AWS_REGION || 'us-east-1',
        headers,
        fetch,
      });
      return provider(modelId);
    }
  }
}
