/**
 * The non-secret half of the unified auth-provider registry —
 * docs/specs/2026-07-22-unified-auth-gateway.md §3.2/§8.3.
 *
 * `id`, `label`, `door`, the `HarnessAuthKind` a successful connection
 * produces, and per-surface flow ordering — enough for the CLI binary and
 * the browser bundle to render the "sign in with an account" door without
 * ever importing anything server-only. Dependency-free and node-free, same
 * discipline as `harnesses.ts` (no `node:` imports, no `process.env`).
 *
 * The SECRET half — OAuth client ids, authorize/token/device URLs, scopes,
 * the actual PKCE/device-code machinery — lives server-side only, in
 * `apps/api/src/llm-gateway/auth/registry.ts`, which imports and re-exports
 * this table rather than redeclaring it.
 *
 * Only the two ACCOUNT-door providers with a real subscription flow live
 * here (Anthropic, OpenAI/Codex). Every API-key-only BYOK provider
 * (Anthropic's own key, OpenAI's own key, and the ~165 other
 * `@kortix/llm-catalog` providers) is already served by that package's
 * `primaryAuthEnvVars`/`isProviderAuthSatisfied` — the CLI
 * (`apps/cli/src/commands/providers.ts`) and web already read it directly
 * for the API-key door (spec §1.1) — so this table does not re-list them.
 * GitHub Copilot and xAI's account door are Phase 2 (spec §7/§11#4): neither
 * has an existing `HarnessAuthKind` to produce, and inventing one here would
 * violate "map onto the EXISTING enum, no new taxonomy" — they are
 * deliberately absent from this array, not merely gated. See
 * `apps/api/src/llm-gateway/auth/registry.ts`'s doc comment for the fuller
 * account of that decision.
 */
import type { HarnessAuthKind } from './harnesses';

/** Which of the two doors (per the owner's Pi-referenced UX) a provider row belongs to. */
export type AuthDoor = 'account' | 'api-key';

/** How a connection is actually completed, ordered by preference per surface. */
export type AuthFlow = 'browser-oauth' | 'device-code' | 'paste-token' | 'paste-api-key';

export interface AuthProviderPublic {
  /** Provider id — matches `@kortix/llm-catalog`'s catalog provider id where one exists. */
  id: string;
  label: string;
  door: AuthDoor;
  /** The ONE existing `HarnessAuthKind` a successful connection through this row produces. */
  producesAuthKind: HarnessAuthKind;
  flows: {
    /** Ordered by preference for the browserless web surface. */
    web: AuthFlow[];
    /** Ordered by preference for the CLI (a real OAuth callback is available there). */
    cli: AuthFlow[];
  };
  /**
   * Present only for the one flow that ships wired-but-off pending an owner
   * decision (spec §11#1) — Anthropic's `browser-oauth`. A flow's mere
   * presence in `flows.cli`/`flows.web` does NOT mean it is reachable;
   * every consumer must check `gatedBehind` against the live flag before
   * offering it.
   */
  gatedBehind?: 'anthropic_oauth_oneclick';
  docsUrl?: string;
}

export const AUTH_PROVIDERS_PUBLIC: readonly AuthProviderPublic[] = [
  {
    id: 'anthropic',
    label: 'Claude Code',
    door: 'account',
    producesAuthKind: 'claude_subscription',
    flows: {
      // Anthropic's written policy forbids third-party relay of a
      // Free/Pro/Max credential (docs/specs/2026-07-21-claude-subscription-
      // parity.md §2) — the sanctioned `claude setup-token` paste is the
      // ONLY web flow, not a degraded fallback. See harnesses.ts's
      // CREDENTIAL_CUSTODY['claude_subscription'] = 'direct-only'.
      web: ['paste-token'],
      cli: ['browser-oauth', 'paste-token'],
    },
    gatedBehind: 'anthropic_oauth_oneclick',
  },
  {
    id: 'openai',
    label: 'ChatGPT / Codex',
    door: 'account',
    producesAuthKind: 'codex_subscription',
    flows: {
      web: ['device-code'],
      cli: ['browser-oauth', 'device-code'],
    },
  },
] as const;

export function findAuthProviderPublic(id: string, door: AuthDoor): AuthProviderPublic | undefined {
  return AUTH_PROVIDERS_PUBLIC.find((provider) => provider.id === id && provider.door === door);
}

export function accountDoorProviders(): readonly AuthProviderPublic[] {
  return AUTH_PROVIDERS_PUBLIC.filter((provider) => provider.door === 'account');
}
