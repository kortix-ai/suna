import { z } from "zod";
import { optStr, optStrDefault, optUrl, optInt, optBoolTrue, optBoolFalse, optBoolUnset, optFallbackPolicies, MORPH_MANAGED_MODELS_DEFAULT, parseMorphManagedModels } from "./env-schema-helpers";
import { PLATFORM_DEFAULT_MODEL_ID } from "@kortix/llm-catalog";
export const llm_billingSchema = {
  OPENROUTER_API_URL: optUrl('https://openrouter.ai/api/v1'),
  // OpenRouter remains available for the router and project BYOK connections.
  OPENROUTER_API_KEY: optStr,
  MORPH_API_URL: optUrl('https://api.morphllm.com/v1'),
  MORPH_API_KEY: optStr,
  // Managed model IDs that use Morph direct as their first candidate.
  // An empty value disables Morph for every managed model — the default since
  // 2026-09-27 (see MORPH_MANAGED_MODELS_DEFAULT).
  MORPH_MANAGED_MODELS: z.string().default(MORPH_MANAGED_MODELS_DEFAULT).transform(parseMorphManagedModels),
  // Whether a session's sandbox gets the `kortix-connectors` OpenCode MCP
  // server (KORTIX_CONNECTORS_MCP_ENABLED in the guest). It exposes the
  // connector meta-tools plus `secret_call`, the only way to use an
  // HTTPS-broker secret — those have no env var and no readable value, so
  // without a tool the model has to find a shell command in a prompt file.
  //
  // ON by default: the tools are the discoverable surface for capabilities the
  // agent already has. This is the operator kill switch — it takes the MCP
  // server away fleet-wide without a code change.
  //
  // optBoolTrue disables on the literal string `false` ONLY: `0`, `no` and
  // `off` all leave it ON. Write `CONNECTORS_MCP_ENABLED=false`.
  //
  // The email channel sets the guest variable itself from durable session
  // metadata (session-channel-env.ts) and keeps the face either way — that
  // channel was the only consumer before this flag, so turning this off
  // restores the previous behaviour rather than regressing email sessions.
  CONNECTORS_MCP_ENABLED: optBoolTrue,
  // Managed LLM gateway (/v1/llm) — the `kortix` OpenCode provider routes every
  // sandbox model call here. Off by default.
  LLM_GATEWAY_ENABLED: optBoolFalse,
  // CLOUD-ONLY. Whether KORTIX's own managed model lineup exists on this
  // deployment. The lineup routes through Kortix's shared Bedrock and
  // OpenRouter credentials. Kortix bills each route as platform credits.
  // This flag is independent of
  // LLM_GATEWAY_ENABLED above: a self-host still runs the gateway for its own
  // BYOK routing (every sandbox model call goes through `/v1/llm`), it just
  // must never see or route to Kortix's shared credentials. When unset it
  // follows KORTIX_BILLING_INTERNAL_ENABLED (derived below): billing on =
  // managed cloud where the managed lineup is the product; billing off =
  // self-host where it must stay dark. An explicit true/false always wins.
  // See RUNTIME_MANAGED_MODELS (managed-models.ts) and managedCandidates()
  // (descriptors.ts) — both are gated on this and read no managed credentials
  // when off.
  KORTIX_MANAGED_PROVIDER_ENABLED: optBoolUnset,
  // Fleet default for projects with no explicit per-project override. Defaults
  // ON: wherever the gateway is available (master switch above), the managed
  // gateway is the default routing mechanism and every project inherits it
  // unless it explicitly opts out. Turning the per-project flag OFF is a
  // fully supported first-class path (native OpenCode provider management:
  // provider keys injected into the sandbox env, native `provider/model`
  // refs, no gateway URL in the box) — the deliberate lever for deployments
  // like SampleCo that want their own keys end to end. The master switch
  // still wins — LLM_GATEWAY_ENABLED=false forces native OpenCode for
  // everyone regardless of this value — and an operator can set
  // LLM_GATEWAY_DEFAULT_ENABLED=false to opt a whole environment back to
  // native-by-default.
  LLM_GATEWAY_DEFAULT_ENABLED: optBoolTrue,
  // Empty = the in-API gateway at `${KORTIX_URL}/v1/llm`. Set to a standalone
  // gateway's public base (…/v1/llm) to route every sandbox model call there.
  LLM_GATEWAY_BASE_URL: optStr,
  // Runtime routing is control-plane configuration, not a model-catalog
  // constant baked into the gateway binary. Operators can replace the default
  // and define any number of exact-match fallback policies without code changes.
  LLM_GATEWAY_DEFAULT_MODEL: optStrDefault(PLATFORM_DEFAULT_MODEL_ID),
  // Image-capable managed model used when the default receives an image.
  LLM_GATEWAY_VISION_MODEL: optStrDefault('deepseek-v4.1-flash'),
  LLM_GATEWAY_FALLBACK_POLICIES: optFallbackPolicies,
  // Optional JSON array replacing the platform managed-model overlay (transport,
  // upstream id, pricing ref, capabilities). Empty uses the bundled last-known
  // defaults; managed routes are otherwise fully operator-defined.
  LLM_GATEWAY_MANAGED_MODELS: optStr,
  // Runtime source for provider/model metadata. The API keeps the last known
  // snapshot if this source is temporarily unavailable.
  LLM_GATEWAY_CATALOG_URL: optUrl('https://models.dev/api.json'),
  // BYOK resilience: when a user's own provider key hits a rate-limit / quota /
  // billing error (429/402/403), fall over to THIS managed model (billed as
  // Kortix credits) so the turn survives instead of erroring. Empty disables.
  LLM_GATEWAY_BYOK_FALLBACK_MODEL: optStrDefault('deepseek-v4.1-flash'),
  // Dev: reverse-proxy /v1/llm-gateway/* to a standalone gateway on this port,
  // so sandboxes reach it through the API's own tunnel (no separate tunnel).
  LLM_GATEWAY_PROXY_PORT: optInt(0),
  // Where the /v1/llm-gateway/* reverse-proxy forwards. Defaults to
  // 127.0.0.1:LLM_GATEWAY_PROXY_PORT (local, gateway same host). In K8s set to
  // the in-cluster gateway service, e.g. http://kortix-gateway:8090, so the
  // gateway stays internal and sandboxes reach it via the API's public origin.
  LLM_GATEWAY_PROXY_TARGET: optStr,
  OPENAI_API_URL: optUrl('https://api.openai.com/v1'),
  OPENAI_API_KEY: optStr,
  // xAI / Gemini / Groq route their TEXT models through OpenRouter (see
  // router/config/proxy-services.ts), so only base URLs are read there.
  XAI_API_URL: optUrl('https://api.x.ai/v1'),
  GEMINI_API_URL: optUrl('https://generativelanguage.googleapis.com/v1beta'),
  GROQ_API_URL: optUrl('https://api.groq.com/openai/v1'),
  // A room per call, an agents-js worker doing STT->LLM->TTS, a plain LiveKit
  // client page a human opens directly. Defaults match the project's local dev
  // server (ws://localhost:7880, devkey/secret are LiveKit's own published
  // dev-mode credentials, not a real secret) — every real deployment overrides
  // all three.
  LIVEKIT_URL: optStrDefault('ws://localhost:7880'),
  LIVEKIT_API_KEY: optStrDefault('devkey'),
  LIVEKIT_API_SECRET: optStrDefault('secret'),
  STRIPE_SECRET_KEY: optStr,
  STRIPE_WEBHOOK_SECRET: optStr,
  REVENUECAT_WEBHOOK_SECRET: optStr,

};
