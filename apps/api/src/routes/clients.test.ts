import { afterEach, describe, expect, it } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { MobileClientPolicySchema } from '@kortix/api-contract';
import { config } from '../config';
import { registerClientRoutes } from './clients';

const app = new OpenAPIHono();
registerClientRoutes(app);

const get = () => app.request('/v1/clients/mobile');
const saved = {
  MOBILE_MIN_VERSION: config.MOBILE_MIN_VERSION,
  MOBILE_STORE_URL_IOS: config.MOBILE_STORE_URL_IOS,
  MOBILE_STORE_URL_ANDROID: config.MOBILE_STORE_URL_ANDROID,
};
afterEach(() => Object.assign(config, saved));

describe('GET /v1/clients/mobile', () => {
  it('answers 200 with null fields and no Authorization header when nothing is set', async () => {
    Object.assign(config, { MOBILE_MIN_VERSION: '', MOBILE_STORE_URL_IOS: '', MOBILE_STORE_URL_ANDROID: '' });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual({ minimum_version: null, store_url_ios: null, store_url_android: null });
  });

  it('echoes the operator settings and matches the contract schema', async () => {
    Object.assign(config, {
      MOBILE_MIN_VERSION: '1.6.0',
      MOBILE_STORE_URL_IOS: 'https://apps.example.test/ios',
      MOBILE_STORE_URL_ANDROID: 'https://apps.example.test/android',
    });
    const body = await (await get()).json();
    expect(body).toEqual({
      minimum_version: '1.6.0',
      store_url_ios: 'https://apps.example.test/ios',
      store_url_android: 'https://apps.example.test/android',
    });
    expect(MobileClientPolicySchema.safeParse(body).success).toBe(true);
  });
});

describe('MOBILE_MIN_VERSION validation', () => {
  // A malformed minimum would make every device fail open, so config refuses to boot.
  const boot = (value: string) =>
    Bun.spawnSync(['bun', '--env-file=scripts/test.env', '-e', "await import('./src/config')"], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, MOBILE_MIN_VERSION: value },
    });

  it('boots with major.minor.patch and refuses a typo', () => {
    expect(boot('1.6.0').exitCode).toBe(0);
    const bad = boot('1,6,0');
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain('MOBILE_MIN_VERSION');
  });
});
