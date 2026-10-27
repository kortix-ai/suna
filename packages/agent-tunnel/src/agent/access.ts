import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { platform } from 'os';
import { isAbsolute, join } from 'path';

import { isAlive } from './process-liveness';
import { agentTunnelHome } from './service-paths';

/**
 * AnyDesk-style access control, enforced on this machine (contract v2 §A).
 *
 * `<home>/access.json` is the owner's standing answer. Only this package
 * writes it: the `access` and `keep-awake` commands (the terminal, and the
 * desktop app, which runs them), and the agent itself for a change relayed by
 * Kortix. The agent reads it before every call. A machine without the file
 * predates access control and stays `always`.
 */
export type AccessMode = 'ask' | 'always' | 'off';

export interface AccessState {
  mode: AccessMode;
  grantedUntil: string | null;
  deniedUntil: string | null;
  keepAwake: boolean;
}

/** One owner action. `deny` answers the pending request with No. */
export interface AccessChange {
  mode?: AccessMode;
  /** Allow for this many minutes (at most 24 h). */
  grantMinutes?: number;
  /** End the current grant now. */
  revoke?: boolean;
  deny?: boolean;
  keepAwake?: boolean;
}

/**
 * A question for the owner on this machine: an agent call that waits for an
 * answer, or (`change`) a wider access asked for through Kortix, which only
 * the owner on this machine may confirm.
 */
export interface AccessRequest {
  id: string;
  requestedAt: string;
  capability: string;
  method: string;
  change?: AccessChange;
}

/** What `access --json`, `status --json`, and the report to Kortix show. */
export interface AccessView extends AccessState {
  keepAwakeSupported: boolean;
  pendingRequest: Pick<AccessRequest, 'id' | 'capability' | 'requestedAt' | 'change'> | null;
}

/** How long a call waits for the owner to answer the prompt. */
export const ACCESS_HOLD_MS = 20_000;
/** The desktop app touches desktop-app.json this often; older means it is gone (pid reuse). */
export const DESKTOP_APP_HEARTBEAT_MS = 30_000;
/** A grant never lasts longer than this, whatever the file says. */
export const MAX_GRANT_MS = 24 * 3_600_000;
/** "Deny" refuses calls for this long. */
export const DENY_MS = 10 * 60_000;
/**
 * A request is shown to the owner this long. Longer than the hold: a late
 * answer still applies to the agent's next try.
 */
export const REQUEST_FRESH_MS = 60_000;

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

/**
 * A1: the access a pairing starts with. The owner's mode (and keep awake) is
 * a machine setting: a re-pair (`--reauth`, a rejected token, a stale
 * connection) keeps it. A grant or denial belongs to the old pairing and does
 * not carry over. Only a first pairing (no access.json, e.g. after `logout`)
 * picks a default: `ask` when the desktop app can answer a prompt, else `always`.
 */
export function accessAfterPairing(home: string, desktopApp: boolean): AccessState {
  const kept = existsSync(accessFilePath(home)) ? readAccess(home) : null;
  return {
    mode: kept?.mode ?? (desktopApp ? 'ask' : 'always'),
    grantedUntil: null,
    deniedUntil: null,
    keepAwake: kept?.keepAwake ?? false,
  };
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

const keepAwakeSupported = (os: NodeJS.Platform) => os === 'darwin' || os === 'linux';

/** A change as Kortix relays it: only the known fields, each with its type. Throws otherwise. */
export function parseAccessChange(params: unknown): AccessChange {
  const raw = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const change: AccessChange = {};
  if (raw.mode !== undefined) {
    if (!MODES.includes(raw.mode as AccessMode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
    change.mode = raw.mode as AccessMode;
  }
  if (raw.grantMinutes !== undefined) {
    if (typeof raw.grantMinutes !== 'number' || !(raw.grantMinutes > 0)) throw new Error('grantMinutes must be a positive number');
    change.grantMinutes = raw.grantMinutes;
  }
  for (const key of ['revoke', 'deny', 'keepAwake'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') throw new Error(`${key} must be true or false`);
    change[key] = raw[key] as boolean;
  }
  if (Object.keys(change).length === 0) throw new Error('No access change given');
  return change;
}

/** The terminal command that makes `change` on this machine. */
export function accessCommand(change: AccessChange): string {
  const npx = 'npx @kortix/agent-tunnel@latest';
  if (change.keepAwake !== undefined && Object.keys(change).length === 1) return `${npx} keep-awake ${change.keepAwake ? 'on' : 'off'}`;
  const args = [change.mode, change.grantMinutes !== undefined ? `--allow-for ${change.grantMinutes}` : undefined];
  return [`${npx} access`, ...args.filter(Boolean)].join(' ');
}

/** One owner action applied to the current state. Throws on bad input. */
export function nextAccess(current: AccessState, change: AccessChange, now = Date.now()): AccessState {
  const next = { ...current };
  if (change.mode !== undefined) {
    if (!MODES.includes(change.mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
    // A grant or denial belongs to the mode it was given in: switching back
    // to "Ask each time" must ask again.
    if (change.mode !== current.mode) {
      next.grantedUntil = null;
      next.deniedUntil = null;
    }
    next.mode = change.mode;
  }
  if (change.grantMinutes !== undefined) {
    const minutes = Number(change.grantMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('grantMinutes must be a positive number');
    next.grantedUntil = new Date(now + Math.min(minutes * 60_000, MAX_GRANT_MS)).toISOString();
    next.deniedUntil = null;
  }
  if (change.revoke === true) next.grantedUntil = null;
  if (change.deny === true) {
    next.grantedUntil = null;
    next.deniedUntil = new Date(now + DENY_MS).toISOString();
  }
  if (change.keepAwake !== undefined) next.keepAwake = change.keepAwake === true;
  return next;
}

/**
 * True when `next` lets calls run that `current` does not: `always` from
 * another mode, or a grant that reaches further. Only the owner on this
 * machine may widen access; Kortix may only narrow it.
 */
export function accessWidens(current: AccessState, next: AccessState, now = Date.now()): boolean {
  if (next.mode === 'always') return current.mode !== 'always';
  if (next.mode !== 'ask') return false;
  const reach = (state: AccessState) =>
    state.mode === 'ask' && decideAccess(state, now) === 'run' ? Date.parse(state.grantedUntil!) : 0;
  return reach(next) > reach(current);
}

/** The pending request, while the owner can still usefully answer it. */
export function pendingAccessRequest(home = agentTunnelHome(), now = Date.now()): AccessRequest | null {
  const request = readAccessRequest(home);
  return request && now - Date.parse(request.requestedAt) < REQUEST_FRESH_MS ? request : null;
}

export function accessView(home = agentTunnelHome(), os: NodeJS.Platform = platform(), now = Date.now()): AccessView {
  const state = readAccess(home);
  const request = pendingAccessRequest(home, now);
  return {
    ...state,
    // A lapsed grant or denial is none: every reader sees the same answer.
    grantedUntil: state.grantedUntil && Date.parse(state.grantedUntil) > now ? state.grantedUntil : null,
    deniedUntil: state.deniedUntil && Date.parse(state.deniedUntil) > now ? state.deniedUntil : null,
    keepAwakeSupported: keepAwakeSupported(os),
    pendingRequest: request
      ? { id: request.id, capability: request.capability, requestedAt: request.requestedAt, ...(request.change ? { change: request.change } : {}) }
      : null,
  };
}

/**
 * One access change applied as given: the owner's own hand (the `access` and
 * `keep-awake` commands), or a narrowing relayed by Kortix. It answers the
 * pending request: a relayed change that `deny` declines is dropped without
 * refusing calls; a call request is answered.
 */
export function applyAccess(change: AccessChange, home = agentTunnelHome(), now = Date.now()): AccessView {
  const request = readAccessRequest(home);
  const declinesChange = change.deny === true && Boolean(request?.change);
  const own = declinesChange ? { ...change, deny: undefined } : change;
  writeAccess(nextAccess(readAccess(home), own, now), home);
  const answers = own.mode !== undefined || own.grantMinutes !== undefined || change.deny === true;
  if (request && answers && !(Date.parse(request.requestedAt) > now)) rmSync(accessRequestPath(home), { force: true });
  return accessView(home, platform(), now);
}

export function writeAccessRequest(
  input: { capability: string; method: string; change?: AccessChange },
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
