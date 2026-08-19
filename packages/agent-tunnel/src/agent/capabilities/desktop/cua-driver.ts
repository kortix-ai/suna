import { spawn } from 'child_process';
import { existsSync, realpathSync, statSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

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

export interface CuaToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

function candidateBins(): string[] {
  const candidates = [
    process.env.CUA_DRIVER_BIN,
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

function driverEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DRIVER_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function execFile(cmd: string, args: string[], timeoutMs = 30_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: driverEnvironment(),
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

export class CuaDriver {
  private binary: string | null = null;
  private daemonReady = false;

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
    const { stdout } = await execFile(bin, ['--version'], 10_000);
    return stdout.trim();
  }

  async listTools(): Promise<string> {
    const bin = await this.ensureInstalled();
    const { stdout } = await execFile(bin, ['list-tools'], 10_000);
    return stdout.trim();
  }

  async describe(tool: string): Promise<string> {
    const bin = await this.ensureInstalled();
    const { stdout } = await execFile(bin, ['describe', tool], 10_000);
    return stdout.trim();
  }

  async status(): Promise<string> {
    const bin = await this.ensureInstalled();
    const { stdout } = await execFile(bin, ['status'], 10_000);
    return stdout.trim();
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!tool || typeof tool !== 'string') throw new Error('CUA tool name is required');
    await this.ensureDaemonReady();
    const bin = await this.ensureInstalled();
    const payload = JSON.stringify(sanitizeArgs(args));
    let lastError: unknown;

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const { stdout, stderr } = await execFile(bin, ['call', tool, payload], 60_000);
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

    if (platform() === 'darwin') {
      const child = spawn('open', ['-n', '-g', '-a', 'CuaDriver', '--args', 'serve'], {
        detached: true,
        stdio: 'ignore',
        env: driverEnvironment(),
      });
      child.unref();
    } else {
      const child = spawn(bin, ['serve'], {
        detached: true,
        stdio: 'ignore',
        env: driverEnvironment(),
      });
      child.unref();
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      const status = await this.status();
      this.daemonReady = true;
      return { ok: true, status };
    } catch {
      return { ok: true };
    }
  }

  private async ensureDaemonReady(): Promise<void> {
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
