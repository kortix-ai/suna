import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

const INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh';
const INSTALL_PS_URL = 'https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1';

interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface CuaToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

function envOff(value: string | undefined): boolean {
  return !!value && ['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

function candidateBins(): string[] {
  const candidates = [
    process.env.CUA_DRIVER_BIN,
    join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'),
    '/usr/local/bin/cua-driver',
    '/opt/homebrew/bin/cua-driver',
  ];
  return candidates.filter((p): p is string => !!p);
}

function findBinary(): string | null {
  for (const candidate of candidateBins()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function execFile(cmd: string, args: string[], timeoutMs = 30_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function installDriver(): Promise<string> {
  if (envOff(process.env.TUNNEL_CUA_AUTO_INSTALL)) {
    throw new Error('cua-driver is not installed and TUNNEL_CUA_AUTO_INSTALL is disabled');
  }

  if (platform() === 'win32') {
    await execFile('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `irm ${INSTALL_PS_URL} | iex`,
    ], 180_000);
  } else {
    await execFile('/bin/bash', [
      '-lc',
      `/bin/bash -c "$(curl -fsSL ${INSTALL_SCRIPT_URL})" -- --no-modify-path`,
    ], 180_000);
  }

  const installed = findBinary();
  if (!installed) {
    throw new Error('cua-driver install completed, but no cua-driver binary was found');
  }
  return installed;
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
    if (key === 'permissionId' || key === 'permission_id' || key === 'tunnelId' || key === 'tunnel_id') {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export class CuaDriver {
  private binary: string | null = null;
  private installPromise: Promise<string> | null = null;

  async ensureInstalled(): Promise<string> {
    if (this.binary && existsSync(this.binary)) return this.binary;

    const found = findBinary();
    if (found) {
      this.binary = found;
      return found;
    }

    this.installPromise ??= installDriver();
    this.binary = await this.installPromise;
    return this.binary;
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
      });
      child.unref();
    } else {
      const child = spawn(bin, ['serve'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CUA_DRIVER_RS_PERMISSIONS_GATE: process.env.CUA_DRIVER_RS_PERMISSIONS_GATE ?? '0' },
      });
      child.unref();
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      return { ok: true, status: await this.status() };
    } catch {
      return { ok: true };
    }
  }
}
