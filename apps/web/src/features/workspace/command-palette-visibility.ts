/**
 * Legacy workspace commands that remain hidden from the session command palette.
 *
 * Session actions use the menu registry directly and must not be added here.
 */
export const LEGACY_PALETTE_HIDDEN = new Set([
  'workspace',
  'dashboard',
  'scheduled-tasks',
  'files',
  'tunnel',
  'running-services-cmd',
  'agent-browser-cmd',
  'internal-browser-cmd',
  'desktop-cmd',
  'templates',
  'changelog',
  'credits-explained',
  'secrets-manager',
  'api-keys',
  'llm-providers',
  'open-terminal',
  'ssh-quick',
]);
