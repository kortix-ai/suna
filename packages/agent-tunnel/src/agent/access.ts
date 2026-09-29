import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';

import { agentTunnelHome } from './service-paths';

/**
 * AnyDesk-style access control, enforced on this machine (contract v2 §A).
 *
 * `<home>/access.json` is the owner's standing answer. The desktop app writes
 * it (grant, deny, mode); the agent reads it before every call. A machine
 * without the file predates access control and stays `always`.
 */
export type AccessMode = 'ask' | 'always' | 'off';

export interface AccessState {
  mode: AccessMode;
  grantedUntil: string | null;
  deniedUntil: string | null;
  keepAwake: boolean;
}

export interface AccessRequest {
  id: string;
  requestedAt: string;
  capability: string;
  method: string;
}

/** How long a call waits for the owner to answer the prompt. */
export const ACCESS_HOLD_MS = 20_000;
/** The desktop app touches desktop-app.json this often; older means it is gone (pid reuse). */
export const DESKTOP_APP_HEARTBEAT_MS = 30_000;
/** A grant never lasts longer than this, whatever the file says. */
export const MAX_GRANT_MS = 24 * 3_600_000;

const MODES: readonly AccessMode[] = ['ask', 'always', 'off'];
const COMPAT: AccessState = { mode: 'always', grantedUntil: null, deniedUntil: null, keepAwake: false };

export const accessFilePath = (home = agentTunnelHome()) => join(home, 'access.json');
export const accessRequestPath = (home = agentTunnelHome()) => join(home, 'access-request.json');
export const desktopAppPath = (home = agentTunnelHome()) => join(home, 'desktop-app.json');

const isoOrNull = (value: unknown) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);

/** Missing file = `always` (compat). A damaged file fails closed to `ask`. */
export function readAccess(home = agentTunnelHome()): AccessState {
  let raw: string;
  try {
    raw = readFileSync(accessFilePath(home), 'utf8');
  } catch {
    return { ...COMPAT };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      mode: MODES.includes(parsed.mode as AccessMode) ? (parsed.mode as AccessMode) : 'ask',
      grantedUntil: isoOrNull(parsed.grantedUntil),
      deniedUntil: isoOrNull(parsed.deniedUntil),
      keepAwake: parsed.keepAwake === true,
    };
  } catch {
    return { mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false };
  }
}

function writePrivateJson(file: string, home: string, value: unknown): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, file);
}

export function writeAccess(state: AccessState, home = agentTunnelHome()): void {
  writePrivateJson(accessFilePath(home), home, state);
}

export type AccessDecision = 'run' | 'off' | 'denied' | 'ask';

export function decideAccess(state: AccessState, now = Date.now()): AccessDecision {
  if (state.mode === 'always') return 'run';
  if (state.mode === 'off') return 'off';
  const denied = state.deniedUntil ? Date.parse(state.deniedUntil) : 0;
  if (denied > now) return 'denied';
  const granted = state.grantedUntil ? Date.parse(state.grantedUntil) : 0;
  // ponytail: the cap is measured from now, not from when the grant was given;
  // a hand-edited far-future grant still expires within 24 h of any check.
  return granted > now && granted - now <= MAX_GRANT_MS ? 'run' : 'ask';
}

export function writeAccessRequest(
  input: { capability: string; method: string },
  home = agentTunnelHome(),
): AccessRequest {
  const request: AccessRequest = { id: randomUUID(), requestedAt: new Date().toISOString(), ...input };
  writePrivateJson(accessRequestPath(home), home, request);
  return request;
}

export function readAccessRequest(home = agentTunnelHome()): AccessRequest | null {
  try {
    const parsed = JSON.parse(readFileSync(accessRequestPath(home), 'utf8')) as AccessRequest;
    return typeof parsed?.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearAccessRequest(id: string, home = agentTunnelHome()): void {
  if (readAccessRequest(home)?.id === id) rmSync(accessRequestPath(home), { force: true });
}

function isAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Starts the desktop app so it can show the access prompt. The app records how
 * to launch it in `desktop-app.json` at startup and touches the file while it
 * runs; a running app sees the request file itself, so nothing is launched
 * twice. A live pid alone is not proof: after a reboot another process may
 * hold it.
 */
export function wakeDesktopApp(home = agentTunnelHome(), now = Date.now()): 'running' | 'launched' | 'no-app' {
  let app: { command?: unknown; args?: unknown; pid?: unknown; env?: unknown };
  let touchedAt = 0;
  try {
    app = JSON.parse(readFileSync(desktopAppPath(home), 'utf8'));
    touchedAt = statSync(desktopAppPath(home)).mtimeMs;
  } catch {
    return 'no-app';
  }
  if (isAlive(app.pid) && now - touchedAt < DESKTOP_APP_HEARTBEAT_MS) return 'running';
  // A moved or uninstalled app, or a Linux AppImage mount that is gone.
  if (typeof app.command !== 'string' || !isAbsolute(app.command) || !existsSync(app.command)) return 'no-app';
  const args = Array.isArray(app.args) ? app.args.filter((arg): arg is string => typeof arg === 'string') : [];
  const recorded = app.env && typeof app.env === 'object' ? (app.env as Record<string, unknown>) : {};
  // The service runs the app binary as Node; the app itself must start as an app.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AGENT_TUNNEL_HOME;
  for (const [key, value] of Object.entries(recorded)) if (typeof value === 'string') env[key] = value;
  try {
    // Detached: its own process group, so a service restart never takes the app down.
    const child = spawn(app.command, args, { detached: true, stdio: 'ignore', env });
    // spawn reports ENOENT/EACCES as an async 'error' event; unheard, it kills the agent.
    child.on('error', () => {});
    child.unref();
    return 'launched';
  } catch {
    return 'no-app';
  }
}

/** The sleep blocker for `keepAwake`, tied to the agent's lifetime. Windows: unsupported. */
export function keepAwakeCommand(
  platform: NodeJS.Platform,
  pid: number,
): { command: string; args: string[] } | null {
  if (platform === 'darwin') return { command: 'caffeinate', args: ['-s', '-w', String(pid)] };
  if (platform === 'linux') {
    return {
      command: 'systemd-inhibit',
      args: ['--what=sleep', '--who=Kortix', '--why=Keep this computer reachable', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null'],
    };
  }
  return null;
}
