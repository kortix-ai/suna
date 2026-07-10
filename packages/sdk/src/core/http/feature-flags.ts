import { AUTO_MODEL_ENABLED } from '@kortix/llm-catalog';

import { platformConfig } from './config';
import { safeEnv } from './env';

function parseEnvBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

/**
 * Parse a raw env string into a flag override: recognized truthy/falsy values
 * map to true/false, anything else (including unset) is `undefined` = "no
 * opinion, fall through". Exported for hosts that wire literal
 * `process.env.NEXT_PUBLIC_*` reads into `configureKortix({ featureFlags })` —
 * required on Next.js, whose client bundles only inline LITERAL dotted
 * `process.env.NEXT_PUBLIC_X` expressions; the dynamic `safeEnv(name)` lookup
 * here can never be inlined and always yields undefined in the browser.
 */
export function parseFlagOverride(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Resolve one flag: an explicit `configureKortix({ featureFlags })` override
 * wins (the portable path — works on any host); otherwise fall back to the
 * legacy `NEXT_PUBLIC_*` build-time env var (so web keeps working unchanged
 * without calling `configureKortix` for this at all); otherwise the default.
 */
function resolveFlag(override: boolean | undefined, envName: string, defaultValue: boolean): boolean {
  if (override !== undefined) return override;
  return parseEnvBoolean(safeEnv(envName), defaultValue);
}

export interface FeatureFlags {
  disableMobileAdvertising: boolean;
  enableDinoGame: boolean;
  enableProjects: boolean;
  enableAutoModel: boolean;
}

/**
 * Every property below is a getter, so it's resolved lazily on each read
 * rather than frozen at module-eval time — a host's `configureKortix({
 * featureFlags })` is honored immediately, even if it runs after this module
 * was first imported (module eval on non-Next hosts has no guaranteed order
 * relative to the host's own startup/provider code).
 */
export const featureFlags: FeatureFlags = {
  /**
   * When true, hide any mobile app download / install advertising across the web app.
   *
   * Default: false (shown)
   * Set NEXT_PUBLIC_DISABLE_MOBILE_ADVERTISING=true, or
   * configureKortix({ featureFlags: { disableMobileAdvertising: true } }), to hide.
   */
  get disableMobileAdvertising(): boolean {
    return resolveFlag(
      platformConfig().featureFlags?.disableMobileAdvertising,
      'NEXT_PUBLIC_DISABLE_MOBILE_ADVERTISING',
      false,
    );
  },
  /** When true, show the dino game easter egg during provisioning. Default: false. */
  get enableDinoGame(): boolean {
    return resolveFlag(
      platformConfig().featureFlags?.enableDinoGame,
      'NEXT_PUBLIC_ENABLE_DINO_GAME',
      false,
    );
  },
  /**
   * Multi-project paradigm.
   *
   * Default: false. The product ships in single-workspace mode — no Projects
   * section, no project picker, no /projects/[id] view, no project-scoped
   * channel/trigger UI, no @project mentions, no `Add to board` triggers.
   *
   * When true (via NEXT_PUBLIC_ENABLE_PROJECTS=true or
   * configureKortix({ featureFlags: { enableProjects: true } })), the legacy
   * project UI (board, milestones, members, project agents/credentials/templates)
   * is surfaced. The sandbox MUST also have KORTIX_PROJECTS_ENABLED=true for the
   * LLM-side project/ticket tools to register; without that the UI exists but
   * tool calls 503.
   */
  get enableProjects(): boolean {
    return resolveFlag(
      platformConfig().featureFlags?.enableProjects,
      'NEXT_PUBLIC_ENABLE_PROJECTS',
      false,
    );
  },
  /**
   * Expose the AUTO model (the gateway's smart router) in the model picker.
   *
   * Default: AUTO_MODEL_ENABLED (false). While off, the picker hides the "Auto"
   * toggle entirely and every session opts into an explicit model — GLM 5.2 by
   * default (see AUTO_DEFAULT_MODEL_ID in @kortix/llm-catalog). The gateway
   * still resolves `auto` server-side, so this only controls the UI: flip it
   * (via NEXT_PUBLIC_ENABLE_AUTO_MODEL=true or
   * configureKortix({ featureFlags: { enableAutoModel: true } })) to bring the
   * toggle back later.
   */
  get enableAutoModel(): boolean {
    return resolveFlag(
      platformConfig().featureFlags?.enableAutoModel,
      'NEXT_PUBLIC_ENABLE_AUTO_MODEL',
      AUTO_MODEL_ENABLED,
    );
  },
};

// Debug: uncomment to inspect feature flags during development
// if (safeEnv('NODE_ENV') !== 'production') {
//   console.log('[featureFlags]', { ...featureFlags });
// }
