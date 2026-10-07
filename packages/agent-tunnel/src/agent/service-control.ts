import {
  type ServiceStatus,
  getServiceStatus,
  installService,
  pauseService,
  restartService,
  resumeService,
  stopService,
  uninstallService,
} from './service';
import { c, blankLine, field, glyph } from './terminal';

/**
 * Exactly one process may hold a tunnel: the relay closes the older socket with
 * 4004 and the displaced agent stops for good. Anything in the foreground that
 * needs the credential must therefore take it from the background service
 * first, and hand it back if it did not end up using it.
 */
export interface TunnelLease {
  /** True when this lease actually stopped a running service. */
  readonly serviceWasActive: boolean;
  /** Restarts the service if this lease stopped it. Safe to call more than once. */
  resumeService(): void;
}

export function acquireTunnelLease(): TunnelLease {
  const serviceWasActive = getServiceStatus().active === true;
  if (serviceWasActive) stopService();

  let resumed = false;
  return {
    serviceWasActive,
    resumeService() {
      if (!serviceWasActive || resumed) return;
      resumed = true;
      // The drift-safe resume: a unit an app update has moved is reinstalled
      // before it starts, or the service would run a runner that is gone.
      resumeService();
    },
  };
}

/** Service verbs that map one-to-one onto a supervisor operation. */
export const SERVICE_ACTIONS = {
  start: { run: resumeService, label: 'started' },
  stop: { run: pauseService, label: 'paused until `agent-tunnel start`' },
  restart: { run: restartService, label: 'restarted' },
  uninstall: { run: uninstallService, label: 'removed' },
  install: { run: installService, label: 'installed' },
} as const;

export type ServiceAction = keyof typeof SERVICE_ACTIONS;

export function describeService(status: ServiceStatus): string {
  if (!status.installed) return `${glyph.off} not installed`;
  if (status.enabled === false) return `${c.yellow}○${c.reset} paused ${c.dim}· stays stopped until \`agent-tunnel start\`${c.reset}`;
  if (status.active) return `${glyph.on} running ${c.dim}· starts at login${c.reset}`;
  return `${c.yellow}○${c.reset} installed ${c.dim}· stopped${c.reset}`;
}

/**
 * Renders the result of a service verb.
 *
 * These used to be five copy-pasted `console.log(JSON.stringify(...))` wrappers
 * that printed a different shape from `status`. One renderer, one shape.
 */
export function renderServiceAction(action: ServiceAction, status: ServiceStatus): void {
  blankLine();
  console.log(`  ${glyph.on} ${c.bold}Background service ${SERVICE_ACTIONS[action].label}${c.reset}`);
  if (status.path) field('', `${c.dim}${status.path}${c.reset}`);
  if (status.detail) field('', `${c.gray}${status.detail}${c.reset}`);
  blankLine();
}
