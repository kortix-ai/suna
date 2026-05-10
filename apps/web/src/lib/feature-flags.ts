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
  /** When true, show the dino game easter egg during provisioning. Default: false. */
  enableDinoGame: parseEnvBoolean(
    process.env.NEXT_PUBLIC_ENABLE_DINO_GAME,
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
} as const;

// Debug: uncomment to inspect feature flags during development
// if (process.env.NODE_ENV !== 'production') {
//   console.log('[featureFlags]', featureFlags);
// }

