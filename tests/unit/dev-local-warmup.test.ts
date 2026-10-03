import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

/**
 * `pnpm dev` warms the heavy /projects/* routes in the background. Its
 * authed-vs-unauthed fallback is behavior: with SUPABASE_SERVICE_ROLE_KEY the
 * warmup mints a real Supabase session cookie and warms WITH it; without one
 * it must still complete and warm compile-only. That fallback is exactly what
 * used to abort on macOS bash 3.2 (`set -u` + expanding an empty header
 * array), so the characterization asserts completion under the same options
 * the script runs with (`set -euo pipefail`).
 *
 * scripts/dev-local.sh is a launcher, not a library — sourcing it boots the
 * whole stack. The harness therefore lifts the named warmup functions out of
 * the file and runs them in a real bash process with a stub curl on PATH
 * (black-box, the same rule the testing skill sets for CLI changes).
 */
function extractFunction(name: string): string {
  const lines = readFileSync(join(root, 'scripts/dev-local.sh'), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
  if (start === -1) throw new Error(`scripts/dev-local.sh does not define ${name}()`);
  const end = lines.findIndex((line, i) => i > start && line === '}');
  if (end === -1) throw new Error(`${name}() has no closing brace at column 0`);
  return lines.slice(start, end + 1).join('\n');
}

// Records one line per invocation and answers the three local-Supabase admin
// calls the warmup mints a session through. Everything else (the readiness
// probe, the four warmup hits) answers with nothing and exit 0.
const STUB_CURL = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${CURL_LOG:?}"
case "$*" in
  *"/auth/v1/admin/users"*) printf '%s' '{"users":[{"email":"warm@example.test"}]}' ;;
  *"/auth/v1/admin/generate_link"*) printf '%s' '{"hashed_token":"tok-1"}' ;;
  *"/auth/v1/verify"*) printf '%s' '{"access_token":"at-1","refresh_token":"rt-1","expires_in":3600,"expires_at":1234567890,"user":{"id":"u1"}}' ;;
esac
exit 0
`;

// The session blob mint_warm_cookie builds: compact JSON, base64url, the
// `base64-` prefix the sb-kortix-auth-token cookie carries. Same key order as
// the minting code (json.dumps preserves insertion order).
const SESSION = {
  access_token: 'at-1',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 1234567890,
  refresh_token: 'rt-1',
  user: { id: 'u1' },
};
const EXPECTED_COOKIE = `base64-${Buffer.from(JSON.stringify(SESSION)).toString('base64url')}`;

function envWithout(...keys: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of keys) delete env[key];
  return env;
}

function runWarmup(functions: string[], env: NodeJS.ProcessEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'dev-local-warmup-'));
  writeFileSync(join(dir, 'curl'), STUB_CURL);
  chmodSync(join(dir, 'curl'), 0o755);
  const script = join(dir, 'warmup.sh');
  writeFileSync(
    script,
    `#!/usr/bin/env bash\nset -euo pipefail\n${functions.join('\n\n')}\nwarm_frontend_routes\n`,
  );
  const log = join(dir, 'curl.log');
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { ...env, PATH: `${dir}:${env.PATH}`, WEB_PORT: '3111', CURL_LOG: log },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { ...result, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const WARMED_PATHS = [
  '/projects',
  '/projects/warmup-id',
  '/projects/warmup-id/sessions/warmup-id',
  '/projects/warmup-id/files',
];

describe('dev-local route warmup', () => {
  it('completes unauthed: warms the four routes with no Cookie header', () => {
    const run = runWarmup(
      [extractFunction('mint_warm_cookie'), extractFunction('warm_frontend_routes')],
      envWithout('SUPABASE_SERVICE_ROLE_KEY'),
    );
    try {
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout).toContain('pre-compiled (unauthed');
      const warmups = run.calls.filter((call) => call.includes('http://localhost:3111/projects'));
      expect(warmups).toHaveLength(4);
      expect(warmups.map((call) => call.split('http://localhost:3111')[1])).toEqual(WARMED_PATHS);
      expect(warmups.every((call) => !call.includes(' -H '))).toBe(true);
    } finally {
      run.cleanup();
    }
  });

  it('mints the authed cookie and warms the four routes with it', () => {
    const run = runWarmup(
      [extractFunction('mint_warm_cookie'), extractFunction('warm_frontend_routes')],
      {
        ...envWithout('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
        SUPABASE_SERVICE_ROLE_KEY: 'srk-test',
        SUPABASE_ANON_KEY: 'anon-test',
      },
    );
    try {
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout).toContain('pre-rendered AUTHED');
      const warmups = run.calls.filter((call) => call.includes('http://localhost:3111/projects'));
      expect(warmups).toHaveLength(4);
      expect(
        warmups.every(
          (call) =>
            call.includes('-H') &&
            call.includes(`Cookie: sb-kortix-auth-token-3111=${EXPECTED_COOKIE}`),
        ),
      ).toBe(true);
    } finally {
      run.cleanup();
    }
  });
});
