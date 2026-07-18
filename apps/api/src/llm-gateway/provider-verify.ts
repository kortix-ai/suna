// GAP C1 — "Connected" in the provider UI today only means a secret row
// exists in project_secrets; it never proves the key actually works against
// the provider. This module makes ONE cheap, single-attempt, non-streaming
// completion through the exact same resolution + upstream path a real turn
// uses (resolveCandidates -> callUpstream), and classifies the outcome into a
// small state the UI can render directly:
//
//   verified      — the provider accepted the key.
//   invalid       — the provider rejected the key (401/403, or a reauth-
//                    required resolution error like an expired Codex
//                    session). Safe to show red.
//   not_connected — no key is configured for this project/provider at all.
//   unknown        — we couldn't get a clean answer either way (timeout,
//                    network error, 429 rate limit, 5xx, or a resolution
//                    failure unrelated to credentials like "model not
//                    found"). NEVER reported as "invalid" — a transient or
//                    unrelated failure must not read as "your key is dead".
//
// Deliberately non-blocking: nothing here writes to gateway_request_logs or
// spend, and a project's "Connected" state never depends on this succeeding
// — connecting a key always works exactly as it does today; verification is
// a separate, additive signal layered on top.
import {
  GatewayResolutionError,
  callUpstream as realCallUpstream,
  type AuthedPrincipal,
  type UpstreamDescriptor,
} from '@kortix/llm-gateway';
import { resolveCandidates as realResolveCandidates } from './resolution/resolve-candidates';
import { runtimeModelCatalog } from './models/runtime-catalog';

export type ProviderVerifyStatus = 'verified' | 'invalid' | 'unknown' | 'not_connected';

export interface ProviderVerifyResult {
  status: ProviderVerifyStatus;
  message: string;
}

export interface ProviderVerifyDeps {
  resolveCandidates: typeof realResolveCandidates;
  callUpstream: typeof realCallUpstream;
  pickVerificationModel: (providerId: string) => string | null;
}

// Heuristic for "the cheapest model this provider publishes" — the catalog
// carries no live pricing per model (see runtime-catalog.ts's Catalog shape),
// so this is a naming heuristic, not a cost lookup. Cost is bounded anyway:
// the ping below sends a two-word prompt and caps output at 16 tokens, so
// even a full-size flagship model costs fractions of a cent to verify.
// Preferring an explicitly "small" model id when one exists just also avoids
// tripping any model-specific quirks (long cold-start, stricter capacity
// limits) a flagship reasoning model might have.
const CHEAP_MODEL_HINTS = ['nano', 'mini', 'flash', 'haiku', 'lite', 'small'];

function defaultPickVerificationModel(providerId: string): string | null {
  const provider = runtimeModelCatalog.snapshot().providers.find((p) => p.id === providerId);
  const models = provider?.models ?? [];
  if (models.length === 0) return null;
  const cheap = models.find((m) =>
    CHEAP_MODEL_HINTS.some((hint) => m.id.toLowerCase().includes(hint)),
  );
  const chosen = cheap ?? models[0]!;
  return `${providerId}/${chosen.id}`;
}

const DEFAULT_DEPS: ProviderVerifyDeps = {
  resolveCandidates: realResolveCandidates,
  callUpstream: realCallUpstream,
  pickVerificationModel: defaultPickVerificationModel,
};

// Single attempt only — a verification ping must never burn the gateway's
// normal 3x retry budget against a key that's about to fail the same way
// every time. Short timeout so a hung/rate-limited provider fails the check
// fast instead of leaving the UI's "Verifying…" state spinning.
const VERIFY_RETRY = { maxAttempts: 1, timeoutMs: 8_000, deadlineMs: 9_000 } as const;

function upstreamErrorHint(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    const msg = parsed?.error?.message ?? parsed?.message;
    return typeof msg === 'string' && msg.trim() ? msg.trim() : undefined;
  } catch {
    const trimmed = body.trim();
    return trimmed.length > 0 && trimmed.length < 300 ? trimmed : undefined;
  }
}

/**
 * Attempt to verify that the credential connected for `providerId` on this
 * project actually works, via one cheap live completion. Never throws — any
 * unexpected failure classifies as `unknown` rather than propagating, since
 * this is a best-effort signal layered on top of "Connected", not a gate on
 * it.
 */
export async function verifyProviderConnection(
  principal: AuthedPrincipal,
  providerId: string,
  overrides: Partial<ProviderVerifyDeps> = {},
): Promise<ProviderVerifyResult> {
  const deps: ProviderVerifyDeps = { ...DEFAULT_DEPS, ...overrides };

  const modelId = deps.pickVerificationModel(providerId);
  if (!modelId) {
    return {
      status: 'unknown',
      message: `No catalog model is known for "${providerId}" to verify against.`,
    };
  }

  let candidates: UpstreamDescriptor[];
  try {
    candidates = await deps.resolveCandidates(principal, modelId);
  } catch (err) {
    if (err instanceof GatewayResolutionError) {
      if (err.code === 'provider_not_connected') {
        return { status: 'not_connected', message: err.message };
      }
      // A session that was connected but is now expired/revoked (Codex OAuth)
      // reads the same as an invalid key to the user — either way, the thing
      // they connected no longer works and needs re-connecting.
      if (err.code === 'provider_reauth_required') {
        return { status: 'invalid', message: err.message };
      }
      // model_not_found / model_disabled_on_deployment / plan_upgrade_required
      // are catalog/entitlement issues with the model we PICKED to test with,
      // not evidence the credential itself is bad.
      return { status: 'unknown', message: err.message };
    }
    return {
      status: 'unknown',
      message: err instanceof Error ? err.message : "Couldn't resolve an upstream to verify.",
    };
  }

  const descriptor = candidates[0];
  if (!descriptor) {
    return { status: 'unknown', message: 'No upstream candidate was resolved for this provider.' };
  }

  try {
    await deps.callUpstream(
      {
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        max_tokens: 16,
      },
      descriptor,
      { retry: VERIFY_RETRY },
    );
    return { status: 'verified', message: 'The provider accepted the key.' };
  } catch (err) {
    const status = (err as { status?: number } | undefined)?.status;
    const body = (err as { body?: string } | undefined)?.body;
    if (status === 401 || status === 403) {
      return {
        status: 'invalid',
        message: upstreamErrorHint(body) ?? `The provider rejected the key (HTTP ${status}).`,
      };
    }
    if (status === 429) {
      return {
        status: 'unknown',
        message: "Rate limited while verifying — couldn't confirm the key.",
      };
    }
    if (typeof status === 'number') {
      return {
        status: 'unknown',
        message:
          upstreamErrorHint(body) ?? `The provider returned HTTP ${status} — couldn't confirm.`,
      };
    }
    const kind = (err as { kind?: string } | undefined)?.kind;
    if (kind === 'timeout') {
      return { status: 'unknown', message: "Verification timed out — couldn't confirm the key." };
    }
    return {
      status: 'unknown',
      message: err instanceof Error ? err.message : "Couldn't reach the provider to verify.",
    };
  }
}
