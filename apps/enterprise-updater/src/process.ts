import { spawnSync } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
  redact?: string[];
}

export interface CommandRunner {
  run(command: string, args: string[], options?: RunOptions): string;
}

export class ProcessRunner implements CommandRunner {
  run(command: string, args: string[], options: RunOptions = {}): string {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      input: options.input,
      encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error) throw new Error(`unable to run ${command}: ${result.error.message}`);
    if (result.status !== 0) {
      const detail = redact(firstUsefulLine(result.stderr || result.stdout), options.redact ?? []);
      throw new Error(`${command} ${args[0] ?? ''} failed${detail ? `: ${detail}` : ` with exit ${result.status}`}`);
    }
    return result.stdout;
  }
}

function firstUsefulLine(value: string): string {
  const lines = value.split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .map((line) => line.replace(/^[╷│╵]\s*/, '').trim())
    .filter((line) => line.length > 0 && !/^[╷│╵─]+$/.test(line));
  return lines.find((line) => line.startsWith('Error:')) ?? lines[0] ?? '';
}

function redact(value: string, secrets: string[]): string {
  return secrets.filter(Boolean).reduce((result, secret) => result.split(secret).join('[REDACTED]'), value);
}
