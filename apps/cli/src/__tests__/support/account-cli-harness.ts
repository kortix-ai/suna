// Black-box harness for the ACCOUNT-scoped commands (members, groups, tokens,
// roles, audit).
//
// Each run is a real `bun` process against a real Bun.serve fake API, with a
// real on-disk config file — the same contract as
// `__tests__/projects-features.test.ts`. It differs in one way only: it boots a
// generated entry that imports ONE command module instead of `src/index.ts`,
// because dispatch for the new commands is wired by the orchestrator, not here.
// The command's argv contract, exit code, stdout/stderr and the exact HTTP it
// sends are all still asserted from outside the process.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..', '..');
const SRC = join(CLI_ROOT, 'src');

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

export interface FakeApi {
  url: string;
  requests: RecordedRequest[];
  stop(): void;
}

export type Route = (
  req: Request,
  url: URL,
  body: unknown,
) => Response | Promise<Response> | undefined;

/**
 * Start a fake API on an ephemeral port. `handler` sees every request after it
 * has been recorded; returning undefined falls through to a 404 so an
 * unexpected call fails loudly instead of silently succeeding.
 */
export function startFakeApi(handler: Route): FakeApi {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      let body: unknown = undefined;
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        body = await req.json().catch(() => undefined);
      }
      requests.push({
        method: req.method,
        path: url.pathname,
        query: url.search,
        body,
      });
      const res = await handler(req, url, body);
      return res ?? Response.json({ error: `no route for ${req.method} ${url.pathname}` }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/** Write the CLI config that pins the host, token and active account. */
export function writeConfig(
  tmp: string,
  apiBase: string,
  accountId = 'account_1',
): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_test',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: accountId,
          logged_in_at: '2026-01-01T00:00:00.000Z',
          account_slug: 'acct',
          account_name: 'Acct',
        },
      },
    }),
    'utf8',
  );
  return path;
}

/**
 * Generate the entry that runs ONE command's exported function.
 *
 * Mirrors `src/index.ts`'s `finish()`: set `process.exitCode` and let the
 * runtime flush, never `process.exit()` — which drops piped output past the
 * pipe buffer and would make large `--json` assertions flaky.
 */
export function writeRunner(tmp: string, module: string, exportName: string): string {
  const dir = join(tmp, 'runner');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'run.ts');
  writeFileSync(
    path,
    `import { ${exportName} } from ${JSON.stringify(join(SRC, 'commands', module))};\n` +
      `const code = await ${exportName}(process.argv.slice(2));\n` +
      `process.exitCode = code;\n` +
      `try { process.stdin.pause(); (process.stdin as any).unref?.(); } catch {}\n`,
    'utf8',
  );
  return path;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the generated entry with the given argv. */
export async function runCommand(
  runner: string,
  args: string[],
  opts: { cwd: string; configFile?: string; stdin?: string } = { cwd: process.cwd() },
): Promise<RunResult> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: opts.configFile,
    // The prompts module refuses non-TTY input, so `-y` is mandatory in tests
    // for anything destructive. CI=1 additionally keeps openInBrowser inert.
    CI: '1',
  };
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_CLI_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_TOKEN',
    'KORTIX_AUTH_FILE',
    'BASH_ENV',
  ]) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, runner, ...args],
    cwd: opts.cwd,
    env,
    stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}
