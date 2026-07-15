// Shared black-box harness for the `tests/self-host-e2e/fast/*` suite.
//
// Scope note: apps/cli/src/self-host/__tests__/self-host-cli.test.ts already
// exercises the CLI's own render logic in-package (fast, no Docker). This
// harness is the OUTER e2e-shaped layer described in
// docs/specs (self-host e2e coverage) — it spawns the real CLI entrypoint the
// exact same way an operator's shell would, and reads back the two on-disk
// artifacts (.env + docker-compose.yml) as plain text, deliberately without
// pulling in a YAML parser (this directory has no package.json / installed
// deps of its own — see README.md) so it stays a zero-setup `bun test` run.
//
// Nothing here imports from apps/cli — it only shells out to its public
// entrypoint, so it can't collide with the sibling agents editing
// apps/cli/src/** in parallel.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const CLI_ENTRY = resolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  'apps',
  'cli',
  'src',
  'index.ts',
);

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A throwaway config root + CLI config file, isolated per test via a unique
 *  tmpdir — never touches a real `~/.config/kortix` instance, so this is safe
 *  to run alongside any live self-host stacks on the same machine. */
export class SelfHostSandbox {
  readonly tmp: string;
  readonly configRoot: string;
  private readonly cliConfigFile: string;

  constructor() {
    this.tmp = mkdtempSync(join(tmpdir(), 'kortix-self-host-e2e-'));
    this.configRoot = join(this.tmp, 'self-host');
    this.cliConfigFile = join(this.tmp, 'cli-config.json');
  }

  async run(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, 'self-host', ...args],
      env: {
        ...process.env,
        KORTIX_SELF_HOST_CONFIG_DIR: this.configRoot,
        KORTIX_CONFIG_FILE: this.cliConfigFile,
        KORTIX_NO_UPDATE_CHECK: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        ...extraEnv,
      },
      stdin: 'ignore', // never a TTY: forces the CLI's non-interactive path regardless of --yes
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  /** Parse the rendered `.env` into a flat map. Deliberately line-oriented
   *  (not a real dotenv parser): this repo's self-host `.env` never quotes or
   *  multi-lines a value (see writeEnv() in commands/self-host.ts), so a
   *  naive split is exact and dependency-free. */
  readEnv(instance = 'default'): Record<string, string> {
    const content = readFileSync(join(this.configRoot, instance, '.env'), 'utf8');
    const out: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#') || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return out;
  }

  readComposeText(instance = 'default'): string {
    return readFileSync(join(this.configRoot, instance, 'docker-compose.yml'), 'utf8');
  }

  cleanup(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

/** Just the `services:` section of a rendered docker-compose.yml, as text —
 *  cut off before the next top-level (`volumes:`/`networks:`) key so a
 *  top-level volume name (2-space indented, same shape as a service header)
 *  never gets mistaken for a service. */
function servicesSectionText(composeText: string): string {
  const startIdx = composeText.indexOf('\nservices:');
  const from = startIdx === -1 ? composeText : composeText.slice(startIdx + 1);
  const bodyStart = from.indexOf('\n') + 1;
  const rest = from.slice(bodyStart);
  const nextTopLevel = rest.search(/\n[a-zA-Z]/);
  return nextTopLevel === -1 ? rest : rest.slice(0, nextTopLevel);
}

/** Every top-level service name declared under `services:`. */
export function composeServiceNames(composeText: string): string[] {
  const section = servicesSectionText(composeText);
  return [...section.matchAll(/^ {2}([a-zA-Z0-9_-]+):$/gm)].map((m) => m[1] ?? '');
}

/** The raw text block for one service (from its header to the next
 *  same-indent service header or end of the services section). */
export function composeServiceBlock(composeText: string, service: string): string {
  const section = servicesSectionText(composeText);
  const headerRe = new RegExp(`^ {2}${service}:$`, 'm');
  const headerMatch = headerRe.exec(section);
  if (!headerMatch) return '';
  const from = section.slice(headerMatch.index + headerMatch[0].length);
  const nextHeader = from.search(/^ {2}[a-zA-Z0-9_-]+:$/m);
  return from.slice(0, nextHeader === -1 ? undefined : nextHeader);
}

/** Parse a service's `environment:` mapping block (6-space-indented
 *  `KEY: value` lines) into a flat map. Returns {} if the service has no
 *  `environment:` map (e.g. it uses `env_file` only). */
export function composeServiceEnv(serviceBlock: string): Record<string, string> {
  const envHeaderMatch = /^ {4}environment:$/m.exec(serviceBlock);
  if (!envHeaderMatch) return {};
  const from = serviceBlock.slice(envHeaderMatch.index + envHeaderMatch[0].length);
  const nextSameOrLessIndent = from.search(/^ {0,4}[a-zA-Z0-9_-]+:/m);
  const block = from.slice(0, nextSameOrLessIndent === -1 ? undefined : nextSameOrLessIndent);
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = /^ {6}([a-zA-Z0-9_.]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? '';
    const value = m[2] ?? '';
    out[key] = value.replace(/^"(.*)"$/, '$1');
  }
  return out;
}

let cachedHelp: string | undefined;

/** Feature-flag probes against the CLI's own `-h` output, so this suite
 *  degrades gracefully (skip-pending, not a false failure) against a CLI
 *  build that doesn't have a given in-flight flag yet, and self-heals to
 *  "run for real" the moment a sibling agent's change lands — no manual
 *  toggle to remember to flip back. */
export async function selfHostCapabilities(): Promise<{
  allowMissingSecrets: boolean;
  secretsSubcommand: boolean;
  localImages: boolean;
}> {
  if (cachedHelp === undefined) {
    const sandbox = new SelfHostSandbox();
    try {
      const { stdout } = await sandbox.run(['-h']);
      cachedHelp = stdout;
    } finally {
      sandbox.cleanup();
    }
  }
  return {
    allowMissingSecrets: cachedHelp.includes('--allow-missing-secrets'),
    secretsSubcommand: /\bsecrets\s+\[ls\]|\bsecrets set\b/.test(cachedHelp),
    localImages: cachedHelp.includes('--local-images'),
  };
}
