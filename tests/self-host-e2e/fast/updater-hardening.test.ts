import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  composeServiceBlock,
  composeServiceEnv,
  composeServiceField,
  composeServiceLoggingOptions,
  composeServiceNames,
  SelfHostSandbox,
} from '../support/cli';

// Fast, no-Docker coverage for tonight's production-readiness audit fixes on
// the compose/stack side (findings #10-#14) plus the parts of the updater/CLI
// wiring that are observable without a live Docker daemon (findings #3/#4/#7
// and #13). The updater.sh runtime logic itself (continue-on-failure,
// self-heal, lock contention, crash-loop watch, ...) is unit-tested against
// the script's text in apps/cli/src/self-host/__tests__/compose-assets.test.ts
// and was additionally verified against a real Docker daemon with a
// throwaway stub stack (see the PR description) — neither of those fits this
// suite's "fast, zero Docker" contract.

describe('self-host updater/compose hardening (fast, no Docker)', () => {
  let sandbox: SelfHostSandbox;

  beforeEach(() => {
    sandbox = new SelfHostSandbox();
  });

  afterEach(() => sandbox.cleanup());

  test('every rendered service (laptop mode) has bounded, rotated logging', async () => {
    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    const composeText = sandbox.readComposeText();
    const names = composeServiceNames(composeText);
    expect(names.length).toBeGreaterThan(15);
    for (const name of names) {
      const block = composeServiceBlock(composeText, name);
      const logging = composeServiceLoggingOptions(block);
      expect(logging.driver, name).toBe('json-file');
      expect(logging.options['max-size'], name).toBe('10m');
      expect(logging.options['max-file'], name).toBe('3');
    }
  });

  test('every rendered service (laptop mode) has an explicit mem_limit/mem_reservation', async () => {
    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    const composeText = sandbox.readComposeText();
    const names = composeServiceNames(composeText);
    for (const name of names) {
      const block = composeServiceBlock(composeText, name);
      expect(composeServiceField(block, 'mem_limit'), name).toBeTruthy();
      expect(composeServiceField(block, 'mem_reservation'), name).toBeTruthy();
    }
  });

  test('Postgres is protected (negative oom_score_adj); analytics/vector are deprioritized (positive)', async () => {
    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    const composeText = sandbox.readComposeText();

    const db = composeServiceBlock(composeText, 'supabase-db');
    expect(Number(composeServiceField(db, 'oom_score_adj'))).toBeLessThan(0);

    const analytics = composeServiceBlock(composeText, 'supabase-analytics');
    expect(Number(composeServiceField(analytics, 'oom_score_adj'))).toBeGreaterThan(0);

    const vector = composeServiceBlock(composeText, 'supabase-vector');
    expect(Number(composeServiceField(vector, 'oom_score_adj'))).toBeGreaterThan(0);
  });

  test('kortix-updater (holds the Docker socket) is pinned by digest, never :latest or a bare floating :cli tag', async () => {
    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    const composeText = sandbox.readComposeText();
    const updater = composeServiceBlock(composeText, 'kortix-updater');
    const image = composeServiceField(updater, 'image') ?? '';
    expect(image).toMatch(/^docker:\d+\.\d+\.\d+-cli@sha256:[a-f0-9]{64}$/);
  });

  test('supabase-kong no longer depends_on supabase-studio (Studio/Logflare must never gate kortix-api cold boot)', async () => {
    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    const composeText = sandbox.readComposeText();
    const kong = composeServiceBlock(composeText, 'supabase-kong');
    expect(kong).not.toContain('supabase-studio');

    // kortix-api still (correctly) depends on Kong itself.
    const api = composeServiceBlock(composeText, 'kortix-api');
    expect(api).toContain('supabase-kong');
  });

  test('GoTrue rate limiting is actually active (GOTRUE_RATE_LIMIT_HEADER set — otherwise every limit silently no-ops)', async () => {
    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    const composeText = sandbox.readComposeText();
    const auth = composeServiceBlock(composeText, 'supabase-auth');
    const env = composeServiceEnv(auth);
    expect(env.GOTRUE_RATE_LIMIT_HEADER).toBeTruthy();
    expect(env.GOTRUE_RATE_LIMIT_EMAIL_SENT).toBeTruthy();
  });

  test('same compose-level protections hold in domain (prod, 2-replica) mode too', async () => {
    const { code } = await sandbox.run(['init', '--yes', '--domain', 'kortix.example.com']);
    expect(code).toBe(0);
    const composeText = sandbox.readComposeText();
    const names = composeServiceNames(composeText);
    expect(names).toContain('caddy');
    for (const name of names) {
      const block = composeServiceBlock(composeText, name);
      expect(composeServiceLoggingOptions(block).driver, name).toBe('json-file');
      expect(composeServiceField(block, 'mem_limit'), name).toBeTruthy();
    }
    const kong = composeServiceBlock(composeText, 'supabase-kong');
    expect(kong).not.toContain('supabase-studio');
  });

  // `kortix self-host status` (findings #3/#4: run outcomes + drift must be
  // human-visible) is new. Its Docker-touching path (reading the updater's
  // report) can't run in this no-Docker tier, but its guard clause — refusing
  // cleanly on an uninitialized instance, same convention as every other
  // subcommand — is observable without Docker and is the one regression that
  // would be most embarrassing to ship (a crash instead of a clean error).
  test('`status` on an uninitialized instance fails clean, same as every other subcommand', async () => {
    const { code, stderr } = await sandbox.run(['status']);
    expect(code).toBe(1);
    expect(stderr).toContain('not initialized');
  });

  // `ps` is kept as the raw `docker compose ps` passthrough now that `status`
  // is the richer command — both must still be distinct, documented
  // subcommands (not one silently aliased away).
  test('`status` and `ps` are both distinct, documented subcommands', async () => {
    const { stdout } = await sandbox.run(['-h']);
    expect(stdout).toMatch(/\bstatus\b[^\n]*update outcome/);
    expect(stdout).toMatch(/\bps\b[^\n]*docker compose ps/);
  });
});
