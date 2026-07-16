import { DEFAULT_MANAGED_MODEL_IDS } from '@kortix/llm-catalog';

export const MANAGED_MODEL_ID_SET = new Set<string>(DEFAULT_MANAGED_MODEL_IDS);

export const CODEX_AUTH_JSON_SECRET_NAME = 'CODEX_AUTH_JSON';
export const LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME = 'OPENCODE_AUTH_JSON';

export type SecretVisibility = 'shared' | 'private';

/**
 * The visibility toggle on the provider-key connect form. Defaults to
 * `'shared'` — a workspace resource by default, not one member's personal
 * key — with copy that describes what actually happens post-fix: a private
 * key resolves only in the SAVER's own sessions (gateway fallback,
 * getResolvedProjectSecretValue), never anyone else's, and never silently
 * dies the way it did before that fallback existed (2026-07-07 incident).
 */
export const DEFAULT_SECRET_VISIBILITY: SecretVisibility = 'shared';

export const SECRET_VISIBILITY_COPY: Record<
  SecretVisibility,
  { label: string; description: string }
> = {
  shared: {
    label: 'Shared',
    description: 'Usable by every session in this workspace',
  },
  private: {
    label: 'Only me',
    description: 'Only your own sessions route with it',
  },
};
