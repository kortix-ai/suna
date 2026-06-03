// ─── Sandbox Port Constants ──────────────────────────────────────────────────

/**
 * Well-known container ports exposed by the sandbox image.
 * These are the ports INSIDE the container — Docker maps them to random host ports.
 */
export const SANDBOX_PORTS = {
  DESKTOP: '6080',
  DESKTOP_HTTPS: '6081',
  PRESENTATION_VIEWER: '3210',
  STATIC_FILE_SERVER: '3211',
  KORTIX_MASTER: '8000',
  BROWSER_STREAM: '9223',
  BROWSER_VIEWER: '9224',
  SSH: '22',
} as const;
