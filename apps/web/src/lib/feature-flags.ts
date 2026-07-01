import { AUTO_MODEL_ENABLED } from '@kortix/llm-catalog';

function parseEnvBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export const featureFlags = {
  /**
   * When true, hide any mobile app download / install advertising across the web app.
   *
   * Default: false (shown)
   * Set NEXT_PUBLIC_DISABLE_MOBILE_ADVERTISING=true to hide.
   */
  disableMobileAdvertising: parseEnvBoolean(
    process.env.NEXT_PUBLIC_DISABLE_MOBILE_ADVERTISING,
    false,
  ),
  /**
   * Multi-project paradigm.
   *
   * Default: false. The product ships in single-workspace mode — no Projects
   * section, no project picker, no /projects/[id] view, no project-scoped
   * channel/trigger UI, no @project mentions, no `Add to board` triggers.
   *
   * When NEXT_PUBLIC_ENABLE_PROJECTS=true, the legacy project UI
   * (board, milestones, members, project agents/credentials/templates) is
   * surfaced. The sandbox MUST also have KORTIX_PROJECTS_ENABLED=true for the
   * LLM-side project/ticket tools to register; without that the UI exists but
   * tool calls 503.
   */
  enableProjects: parseEnvBoolean(
    process.env.NEXT_PUBLIC_ENABLE_PROJECTS,
    false,
  ),
  /**
   * Expose the AUTO model (the gateway's smart router) in the model picker.
   *
   * Default: AUTO_MODEL_ENABLED (false). While off, the picker hides the "Auto"
   * toggle entirely and every session opts into an explicit model — GLM 5.2 by
   * default (see AUTO_DEFAULT_MODEL_ID in @kortix/llm-catalog). The gateway
   * still resolves `auto` server-side, so this only controls the UI: flip it (or
   * set NEXT_PUBLIC_ENABLE_AUTO_MODEL=true) to bring the toggle back later.
   */
  enableAutoModel: parseEnvBoolean(
    process.env.NEXT_PUBLIC_ENABLE_AUTO_MODEL,
    AUTO_MODEL_ENABLED,
  ),
} as const;

// Debug: uncomment to inspect feature flags during development
// if (process.env.NODE_ENV !== 'production') {
//   console.log('[featureFlags]', featureFlags);
// }
