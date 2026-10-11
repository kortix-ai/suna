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
