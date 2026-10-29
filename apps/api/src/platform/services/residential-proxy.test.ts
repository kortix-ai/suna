// `residential_proxy`: which hosts a proxied box still dials directly.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { config } from '../../config';
import { bypassHost, resolveSessionResidentialProxy } from './residential-proxy';

const ON = { experimental: { residential_proxy: true } };

const KEYS = [
  'KORTIX_URL',
  'LLM_GATEWAY_BASE_URL',
  'PLATINUM_API_KEY',
  'KORTIX_CONFIG_ARCHIVE_S3_BUCKET',
  'KORTIX_PROJECT_SNAPSHOT_S3_BUCKET',
] as const;
let saved: Partial<typeof config>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, config[key]]));
  config.PLATINUM_API_KEY = 'pt_test_key';
  config.KORTIX_URL = 'https://api.example.com';
  config.LLM_GATEWAY_BASE_URL = 'https://gateway.example.com:8443/v1';
  // No object store: each test that wants one configures it.
  config.KORTIX_CONFIG_ARCHIVE_S3_BUCKET = '';
  config.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET = '';
});
afterEach(() => Object.assign(config, saved));

describe('resolveSessionResidentialProxy', () => {
  test('flag off or unset ⇒ no option', async () => {
    expect(await resolveSessionResidentialProxy({ experimental: { residential_proxy: false } })).toBeUndefined();
    expect(await resolveSessionResidentialProxy({})).toBeUndefined();
  });

  test('flag on ⇒ the API and gateway hosts bypass the proxy; an unconfigured object store adds none', async () => {
    expect(await resolveSessionResidentialProxy(ON)).toEqual({ bypass: ['api.example.com', 'gateway.example.com'] });
  });

  test('the object store a box downloads its boot files from bypasses the proxy, at the host it signs for', async () => {
    // The signing client is built once per process; the region is the one scripts/test.env sets.
    config.KORTIX_CONFIG_ARCHIVE_S3_BUCKET = 'boot-files';
    expect((await resolveSessionResidentialProxy(ON))?.bypass).toEqual([
      'api.example.com',
      'gateway.example.com',
      'boot-files.s3.us-east-1.amazonaws.com',
    ]);
  });

  test('without Platinum the flag is unavailable ⇒ no option', async () => {
    config.PLATINUM_API_KEY = '';
    expect(await resolveSessionResidentialProxy(ON)).toBeUndefined();
  });

  test('a local API on localhost is never sent as a bypass host', async () => {
    config.KORTIX_URL = 'http://localhost:8008';
    config.LLM_GATEWAY_BASE_URL = '';
    expect(await resolveSessionResidentialProxy(ON)).toEqual({ bypass: [] });
  });
});

describe('bypassHost', () => {
  test.each([
    ['https://dev-api.kortix.com/v1', 'dev-api.kortix.com'],
    ['https://Abc-Tunnel.trycloudflare.com:443/v1/router', 'abc-tunnel.trycloudflare.com'],
    ['https://bücher.example/x', 'xn--bcher-kva.example'],
    ['http://localhost:8008', null],
    ['http://api.localhost', null],
    ['http://127.0.0.1:8008/v1', null],
    ['http://[::1]:8008/v1', null],
    ['not a url', null],
    ['', null],
  ])('%s → %s', (url, host) => {
    expect(bypassHost(url)).toBe(host);
  });
});
