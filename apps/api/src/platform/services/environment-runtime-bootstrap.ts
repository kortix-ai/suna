import { readFileSync } from 'node:fs';
import { getProvider } from '../providers';

export const ENVIRONMENT_RUNTIME_VERSION = 1;

export async function ensureEnvironmentRuntimeStarted(externalId: string, reuseWorkspace = false): Promise<void> {
  const provider = getProvider('daytona');
  if (!provider.exec) throw new Error('Environment provider cannot start the workspace daemon');
  const script = readFileSync(new URL('./environment-runtime-bootstrap.py', import.meta.url), 'utf8');
  const result = await provider.exec(externalId, ['sudo', '-n', '-E', 'python3', '-c', script, '/', ...(reuseWorkspace ? ['reuse'] : [])], {
    timeoutMs: 240_000,
  });
  const output = result.stdout.trim().split('\n').at(-1);
  let report: { ready?: boolean; error?: string } | null = null;
  try { report = output ? JSON.parse(output) : null; } catch {}
  if (result.exitCode !== 0) throw new Error(`Environment daemon bootstrap failed: ${report?.error?.slice(0, 300) || 'provider command failed'}`);
  if (report?.ready !== true) throw new Error('Environment daemon did not confirm execution-only readiness');
}
