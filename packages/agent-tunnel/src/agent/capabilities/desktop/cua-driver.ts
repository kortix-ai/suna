import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'fs';
import { homedir, platform, tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { agentTunnelHome, serviceLabelFor, SERVICE_LABEL } from '../../service-paths';

interface ExecResult {
  stdout: string;
  stderr: string;
}

const MAX_DRIVER_OUTPUT_BYTES = 5 * 1024 * 1024;
const DRIVER_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

/** The driver's own product telemetry stays off on a customer's machine. */
function driverEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' };
  for (const key of DRIVER_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

export interface CuaToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

/**
 * The driver the desktop app ships in its own bundle, beside the agent:
 * `Resources/agent-tunnel/agent-cli.js` → `Resources/cua-driver/cua-driver`.
 * Running it embedded keeps every macOS permission prompt and grant on the
 * Kortix app, not on a separate CuaDriver app. `null` for an npm install.
 */
export function bundledCuaDriverPath(agentEntry: string | undefined = process.argv[1]): string | null {
  if (!agentEntry || basename(dirname(agentEntry)) !== 'agent-tunnel') return null;
  const exe = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
  const candidate = join(dirname(dirname(agentEntry)), 'cua-driver', exe);
  return existsSync(candidate) ? candidate : null;
}

function candidateBins(): string[] {
  const candidates = [
    process.env.CUA_DRIVER_BIN,
    bundledCuaDriverPath(),
    join(
      homedir(),
      '.local',
      'bin',
      process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver',
    ),
    '/usr/local/bin/cua-driver',
    '/opt/homebrew/bin/cua-driver',
  ];
  return candidates.filter((p): p is string => !!p);
}

export function findCuaDriverBinary(): string | null {
  for (const candidate of candidateBins()) {
    if (!existsSync(candidate)) continue;
    const resolved = realpathSync(candidate);
    const stats = statSync(resolved);
    if (!stats.isFile()) throw new Error(`cua-driver is not a regular file: ${candidate}`);
    if (process.platform !== 'win32') {
      const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (currentUid !== undefined && stats.uid !== currentUid && stats.uid !== 0) {
        throw new Error(`cua-driver is not owned by the current user or root: ${resolved}`);
      }
      if ((stats.mode & 0o022) !== 0) {
        throw new Error(`cua-driver must not be writable by group or other users: ${resolved}`);
      }
      if ((stats.mode & 0o111) === 0) {
        throw new Error(`cua-driver is not executable: ${resolved}`);
      }
    }
    return resolved;
  }
  return null;
}

/** The `CFBundleIdentifier` of the app whose binary runs this agent, if any. */
function hostBundleId(): string {
  try {
    const plist = readFileSync(join(dirname(dirname(process.execPath)), 'Info.plist'), 'utf8');
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? '';
  } catch {
    return '';
  }
}

function execFile(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
  env: NodeJS.ProcessEnv = driverEnvironment(),
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const rejectAndKill = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill('SIGKILL');
      reject(error);
    };

    const timer = setTimeout(() => {
      rejectAndKill(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (data: Buffer) => {
      outputBytes += data.byteLength;
      if (outputBytes > MAX_DRIVER_OUTPUT_BYTES) {
        rejectAndKill(new Error('cua-driver output exceeds the 5 MiB limit'));
        return;
      }
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      outputBytes += data.byteLength;
      if (outputBytes > MAX_DRIVER_OUTPUT_BYTES) {
        rejectAndKill(new Error('cua-driver output exceeds the 5 MiB limit'));
        return;
      }
      stderr += data.toString();
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim();
        reject(new Error(`${cmd} failed (${code})${detail ? `: ${detail}` : ''}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    proc.on('error', (err) => {
      rejectAndKill(err);
    });
  });
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function isDaemonProxyFallback(message: string): boolean {
  return message.includes('daemon proxy') && message.includes('Resource temporarily unavailable');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (
      key === '__permission' ||
      key === '_sig' ||
      key === '_nonce' ||
      key === 'permissionId' ||
      key === 'permission_id' ||
      key === 'tunnelId' ||
      key === 'tunnel_id'
    ) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export interface CuaDriverOptions {
  /** A resolved driver binary. Default: the bundled one, else an installed one. */
  binary?: string;
  /** Run the driver inside this app's macOS permissions. Default: the bundled driver. */
  embedded?: boolean;
  socketPath?: string;
  hostBundleId?: string;
}

/**
 * The local computer-use driver (trycua `cua-driver`).
 *
 * - Embedded (the driver the desktop app bundles): this agent spawns
 *   `serve --embedded` as its own child on a private socket. The agent runs as
 *   the Kortix app's binary, so macOS attributes Accessibility and Screen
 *   Recording to Kortix: one grant, one entry in System Settings, no CuaDriver
 *   app. The driver never shows its own permission UI (`--no-permissions-gate`);
 *   the desktop app asks for the grants.
 * - Standalone (a separately installed CuaDriver.app): unchanged, it starts
 *   through LaunchServices and owns its own grants.
 */
export class CuaDriver {
  private binary: string | null;
  private readonly embedded: boolean | undefined;
  private readonly socketPath: string;
  private readonly hostBundleId: string | undefined;
  private daemonReady = false;
  private daemon: ChildProcess | null = null;

  constructor(options: CuaDriverOptions = {}) {
    this.binary = options.binary ?? null;
    this.embedded = options.embedded;
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
    // One driver per agent home (the label's suffix), so two homes never share
    // or steal a driver. Under $TMPDIR: a socket path is capped at 104 bytes on macOS.
    const home = serviceLabelFor(agentTunnelHome()).slice(SERVICE_LABEL.length);
    this.socketPath = options.socketPath ?? join(tmpdir(), `kortix-cua-${uid}${home}.sock`);
    this.hostBundleId = options.hostBundleId;
  }

  private isEmbedded(binary: string): boolean {
    return this.embedded ?? binary === bundledCuaDriverPath();
  }

  /** Environment and trailing arguments every driver command needs in this mode. */
  private mode(binary: string): { env: NodeJS.ProcessEnv; socket: string[] } {
    if (!this.isEmbedded(binary)) return { env: driverEnvironment(), socket: [] };
    return {
      env: driverEnvironment({
        CUA_DRIVER_EMBEDDED: '1',
        CUA_DRIVER_HOST_BUNDLE_ID: this.hostBundleId ?? hostBundleId(),
      }),
      socket: ['--socket', this.socketPath],
    };
  }

  async ensureInstalled(): Promise<string> {
    if (this.binary && existsSync(this.binary)) return this.binary;

    const found = findCuaDriverBinary();
    if (found) {
      this.binary = found;
      return found;
    }

    throw new Error(
      'cua-driver is not installed. Install it locally before enabling Computer Use. Agent Tunnel never downloads or executes remote installers.',
    );
  }

  async version(): Promise<string> {
    const bin = await this.ensureInstalled();
    const { stdout } = await execFile(bin, ['--version'], 10_000, this.mode(bin).env);
    return stdout.trim();
  }

  async listTools(): Promise<string> {
    const bin = await this.ensureInstalled();
    const { stdout } = await execFile(bin, ['list-tools'], 10_000, this.mode(bin).env);
    return stdout.trim();
  }

  async describe(tool: string): Promise<string> {
    const bin = await this.ensureInstalled();
    const { stdout } = await execFile(bin, ['describe', tool], 10_000, this.mode(bin).env);
    return stdout.trim();
  }

  async status(): Promise<string> {
    const bin = await this.ensureInstalled();
    const { env, socket } = this.mode(bin);
    const { stdout } = await execFile(bin, ['status', ...socket], 10_000, env);
    return stdout.trim();
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!tool || typeof tool !== 'string') throw new Error('CUA tool name is required');
    await this.ensureDaemonReady();
    const bin = await this.ensureInstalled();
    const { env, socket } = this.mode(bin);
    const payload = JSON.stringify(sanitizeArgs(args));
    let lastError: unknown;

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const { stdout, stderr } = await execFile(bin, ['call', tool, payload, ...socket], 60_000, env);
        if (isDaemonProxyFallback(stderr)) {
          lastError = new Error(stderr.trim());
          await sleep(150 * (attempt + 1));
          continue;
        }
        return parseJsonOutput(stdout);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isDaemonProxyFallback(message)) {
          throw err;
        }
        lastError = err;
        await sleep(150 * (attempt + 1));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async startDaemon(): Promise<{ ok: true; status?: string }> {
    const bin = await this.ensureInstalled();

    if (this.isEmbedded(bin)) {
      await this.startEmbeddedDaemon(bin);
      this.daemonReady = true;
      return { ok: true };
    } else if (platform() === 'darwin') {
      const child = spawn('open', ['-n', '-g', '-a', 'CuaDriver', '--args', 'serve'], {
        detached: true,
        stdio: 'ignore',
        env: driverEnvironment(),
      });
      child.unref();
      await sleep(750);
    } else {
      const child = spawn(bin, ['serve'], {
        detached: true,
        stdio: 'ignore',
        env: driverEnvironment(),
      });
      child.unref();
      await sleep(750);
    }

    try {
      const status = await this.status();
      this.daemonReady = true;
      return { ok: true, status };
    } catch {
      return { ok: true };
    }
  }

  /**
   * A direct child (never `open`, which would hand it to LaunchServices and
   * out of this app's permission chain). It exits with the agent.
   */
  private async startEmbeddedDaemon(bin: string): Promise<void> {
    if (this.daemon && this.daemon.exitCode === null) return;
    const { env, socket } = this.mode(bin);
    // A socket this agent did not just start is stale: a previous agent left it
    // when it exited, and the driver refuses to start over an existing endpoint.
    // Stop whatever may still answer on it (it runs outside this process's
    // macOS permissions), then remove it.
    if (existsSync(this.socketPath)) {
      await execFile(bin, ['stop', ...socket], 10_000, env).catch(() => undefined);
      rmSync(this.socketPath, { force: true });
    }
    const child = spawn(bin, ['serve', '--embedded', '--no-permissions-gate', ...socket], {
      stdio: 'ignore',
      env,
    });
    child.unref();
    child.on('exit', () => {
      if (this.daemon === child) {
        this.daemon = null;
        this.daemonReady = false;
      }
    });
    this.daemon = child;
    process.once('exit', () => child.kill());
    for (let waited = 0; waited < 10_000 && !existsSync(this.socketPath); waited += 50) {
      if (child.exitCode !== null) break;
      await sleep(50);
    }
    if (!existsSync(this.socketPath)) {
      child.kill();
      throw new Error('cua-driver did not start (no socket after 10 s)');
    }
  }

  /**
   * The macOS grants the driver reports missing for its permission owner:
   * Kortix when embedded, CuaDriver otherwise. Empty when nothing is missing
   * or the platform has no such grants.
   */
  /** The app macOS shows in Privacy & Security for this driver's grants. */
  async permissionOwner(): Promise<string> {
    return this.isEmbedded(await this.ensureInstalled()) ? 'Kortix' : 'CuaDriver';
  }

  async missingPermissions(): Promise<string[]> {
    const report = (await this.call('check_permissions', {})) as Record<string, unknown> | null;
    const missing: string[] = [];
    if (report?.accessibility === false) missing.push('Accessibility');
    if (report?.screen_recording === false) missing.push('Screen Recording');
    return missing;
  }

  /** Stops an embedded daemon this agent started. Restarting picks up new grants. */
  stop(): void {
    this.daemon?.kill();
    this.daemon = null;
    this.daemonReady = false;
  }

  private async ensureDaemonReady(): Promise<void> {
    const bin = await this.ensureInstalled();
    // Embedded: only a driver this agent started runs inside its permissions.
    if (this.isEmbedded(bin)) {
      if (this.daemon?.exitCode === null && existsSync(this.socketPath)) return;
      this.stop();
      await this.startDaemon();
      return;
    }
    if (this.daemonReady) return;
    try {
      const status = await this.status();
      if (/not\s+running|stopped|unavailable/i.test(status)) {
        throw new Error(status);
      }
      this.daemonReady = true;
    } catch {
      await this.startDaemon();
      this.daemonReady = true;
    }
  }
}
