import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const DEFAULT_AGENT_ENV_SH = '/dev/shm/kortix/agent-env.sh';

const SANDBOX_ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_FRONTEND_URL',
  'KORTIX_PROJECT_ID',
] as const;

type SandboxEnvKey = (typeof SANDBOX_ENV_KEYS)[number];

const ALLOWED_KEYS = new Set<string>(SANDBOX_ENV_KEYS);

function candidatePaths(): string[] {
  if (process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE === '1') return [];
  const paths: string[] = [];
  if (process.env.BASH_ENV && basename(process.env.BASH_ENV) === 'agent-env.sh') {
    paths.push(process.env.BASH_ENV);
  }
  paths.push(DEFAULT_AGENT_ENV_SH);
  return Array.from(new Set(paths));
}

function parseGeneratedExportValue(raw: string): string | null {
  const value = raw.trim();
  if (!value.startsWith("'")) return null;
  let out = '';
  for (let i = 1; i < value.length; i += 1) {
    const ch = value[i];
    if (ch !== "'") {
      out += ch;
      continue;
    }
    if (value.slice(i, i + 4) === "'\\''") {
      out += "'";
      i += 3;
      continue;
    }
    return value.slice(i + 1).trim() ? null : out;
  }
  return null;
}

function readSandboxEnvFile(): Partial<Record<SandboxEnvKey, string>> {
  for (const path of candidatePaths()) {
    if (!existsSync(path)) continue;
    const out: Partial<Record<SandboxEnvKey, string>> = {};
    try {
      const body = readFileSync(path, 'utf8');
      for (const line of body.split(/\r?\n/)) {
        const match = /^export\s+([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
        if (!match || !ALLOWED_KEYS.has(match[1])) continue;
        const value = parseGeneratedExportValue(match[2]);
        if (value != null) out[match[1] as SandboxEnvKey] = value;
      }
    } catch {
      continue;
    }
    return out;
  }
  return {};
}

export function sandboxEnvValue(name: SandboxEnvKey): string | undefined {
  if (process.env[name]) return process.env[name];
  return readSandboxEnvFile()[name];
}
