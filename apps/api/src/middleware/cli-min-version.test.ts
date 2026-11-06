import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { config } from '../config';
import { BUILT_IN_CLI_MIN_VERSION, outdatedCliVersion, rejectOutdatedCli } from './cli-min-version';

const app = new Hono();
app.use('/v1/*', rejectOutdatedCli);
app.get('/v1/accounts', (c) => c.json({ ok: true }));

const saved = config.CLI_MIN_VERSION;
afterEach(() => Object.assign(config, { CLI_MIN_VERSION: saved }));
const get = (version?: string) =>
  app.request('/v1/accounts', { headers: version ? { 'X-Kortix-Client-Version': version } : {} });

describe('outdatedCliVersion', () => {
  it('names a CLI below the minimum and passes the rest', () => {
    expect(outdatedCliVersion('cli/0.14.8', '0.14.13')).toBe('0.14.8');
    expect(outdatedCliVersion('cli/0.13.54-dev', '0.14.13')).toBe('0.13.54');
    expect(outdatedCliVersion('cli/0.14.13', '0.14.13')).toBeNull();
    expect(outdatedCliVersion('cli/0.14.13-dev.3604bad5', '0.14.13')).toBeNull();
    expect(outdatedCliVersion('cli/1.0.0', 'v0.15')).toBeNull();
    expect(outdatedCliVersion('cli/0.14.99', '0.15')).toBe('0.14.99');
  });

  it('judges only a CLI with a numeric version', () => {
    expect(outdatedCliVersion('cli/dev', '0.14.13')).toBeNull();
    expect(outdatedCliVersion('mobile/1.5.3', '9.9.9')).toBeNull();
    expect(outdatedCliVersion(undefined, '0.14.13')).toBeNull();
  });
});

describe('rejectOutdatedCli', () => {
  it('answers 426 with the update command to an old CLI', async () => {
    Object.assign(config, { CLI_MIN_VERSION: '0.14.13' });
    const res = await get('cli/0.14.8');
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({
      error: 'This Kortix CLI (0.14.8) is older than this server supports (minimum 0.14.13). Update it: kortix update',
      code: 'cli_too_old',
      minimum_version: '0.14.13',
    });
  });

  it('passes a current CLI, another client, and a request with no version', async () => {
    Object.assign(config, { CLI_MIN_VERSION: '0.14.13' });
    expect((await get('cli/0.14.20')).status).toBe(200);
    expect((await get('mobile/1.5.3')).status).toBe(200);
    expect((await get('cli/dev')).status).toBe(200);
    expect((await get()).status).toBe(200);
  });
});

describe('the built-in minimum', () => {
  // A CLI before 0.14.13 reads OpenCode routes this API and the session box no longer serve.
  it('is 0.14.13', () => {
    expect(BUILT_IN_CLI_MIN_VERSION).toBe('0.14.13');
  });

  it('refuses an older CLI when CLI_MIN_VERSION is unset', async () => {
    Object.assign(config, { CLI_MIN_VERSION: '' });
    const res = await get('cli/0.14.8');
    expect(res.status).toBe(426);
    expect(((await res.json()) as { minimum_version: string }).minimum_version).toBe('0.14.13');
    expect((await get('cli/0.14.13')).status).toBe(200);
  });

  it('a lower CLI_MIN_VERSION cannot lower it', async () => {
    Object.assign(config, { CLI_MIN_VERSION: '0.13.0' });
    const res = await get('cli/0.14.8');
    expect(res.status).toBe(426);
    expect(((await res.json()) as { minimum_version: string }).minimum_version).toBe('0.14.13');
  });

  it('a higher CLI_MIN_VERSION raises it', async () => {
    Object.assign(config, { CLI_MIN_VERSION: '0.15.2' });
    const res = await get('cli/0.15.1');
    expect(res.status).toBe(426);
    expect(((await res.json()) as { minimum_version: string }).minimum_version).toBe('0.15.2');
    expect((await get('cli/0.15.2')).status).toBe(200);
  });
});

describe('CLI_MIN_VERSION validation', () => {
  const boot = (value: string) =>
    Bun.spawnSync(['bun', '--env-file=scripts/test.env', '-e', "await import('./src/config')"], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, CLI_MIN_VERSION: value },
    });

  it('boots with major.minor.patch and refuses a typo', () => {
    expect(boot('0.14.13').exitCode).toBe(0);
    const bad = boot('0,14');
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain('CLI_MIN_VERSION');
  });
});
