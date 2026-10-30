// A sandbox template's `residential_proxy`: the create option a session gets,
// which hosts it still dials directly, and the fail-closed refusals.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { config } from '../../config';
import { bypassHost, residentialProxyOffered, resolveSessionResidentialProxy } from './residential-proxy';
import { classifySandboxProvisioningFailure } from './sandbox-provisioning-error';

const KEYS = [
  'KORTIX_URL',
  'LLM_GATEWAY_BASE_URL',
  'PLATINUM_API_KEY',
  'KORTIX_PLATINUM_RESIDENTIAL_PROXY',
  'KORTIX_CONFIG_ARCHIVE_S3_BUCKET',
  'KORTIX_PROJECT_SNAPSHOT_S3_BUCKET',
  'KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID',
  'KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY',
] as const;
let saved: Partial<typeof config>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, config[key]]));
  config.PLATINUM_API_KEY = 'pt_test_key';
  config.KORTIX_PLATINUM_RESIDENTIAL_PROXY = true;
  // Presigning is local only when credentials do not fall through to instance metadata.
  config.KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID = 'unit-test-access-key';
  config.KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY = 'unit-test-secret-key';
  config.KORTIX_URL = 'https://api.example.com';
  config.LLM_GATEWAY_BASE_URL = 'https://gateway.example.com:8443/v1';
  // No object store: each test that wants one configures it.
  config.KORTIX_CONFIG_ARCHIVE_S3_BUCKET = '';
  config.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET = '';
});
afterEach(() => Object.assign(config, saved));

async function refusal(run: () => Promise<unknown>) {
  const error = await run().then(() => null, (err: unknown) => err);
  expect(error).toBeInstanceOf(Error);
  return classifySandboxProvisioningFailure(error);
}

describe('the KORTIX_PLATINUM_RESIDENTIAL_PROXY operator gate', () => {
  test('not offered without the switch, offered with it and Platinum', () => {
    config.KORTIX_PLATINUM_RESIDENTIAL_PROXY = false;
    expect(residentialProxyOffered()).toBe(false);
    config.KORTIX_PLATINUM_RESIDENTIAL_PROXY = true;
    expect(residentialProxyOffered()).toBe(true);
    config.PLATINUM_API_KEY = '';
    expect(residentialProxyOffered()).toBe(false);
  });
});

describe('resolveSessionResidentialProxy', () => {
  test('a template that does not ask ⇒ no option, on any deployment and provider', async () => {
    config.KORTIX_PLATINUM_RESIDENTIAL_PROXY = false;
    expect(await resolveSessionResidentialProxy(null, 'platinum')).toBeUndefined();
    expect(await resolveSessionResidentialProxy(undefined, 'daytona')).toBeUndefined();
  });

  test('a template that asks ⇒ the API and gateway hosts bypass the proxy; an unconfigured object store adds none', async () => {
    expect(await resolveSessionResidentialProxy({}, 'platinum')).toEqual({
      bypass: ['api.example.com', 'gateway.example.com'],
    });
  });

  test('a country rides along', async () => {
    expect(await resolveSessionResidentialProxy({ country: 'us' }, 'platinum')).toEqual({
      bypass: ['api.example.com', 'gateway.example.com'],
      country: 'us',
    });
  });

  test('the object store a box downloads its boot files from bypasses the proxy, at the host it signs for', async () => {
    // The signing client is built once per process; the region is the one scripts/test.env sets.
    config.KORTIX_CONFIG_ARCHIVE_S3_BUCKET = 'boot-files';
    expect((await resolveSessionResidentialProxy({}, 'platinum'))?.bypass).toEqual([
      'api.example.com',
      'gateway.example.com',
      'boot-files.s3.us-east-1.amazonaws.com',
    ]);
  });

  test('a local API on localhost is never sent as a bypass host', async () => {
    config.KORTIX_URL = 'http://localhost:8008';
    config.LLM_GATEWAY_BASE_URL = '';
    expect(await resolveSessionResidentialProxy({}, 'platinum')).toEqual({ bypass: [] });
  });

  test('fail closed: a deployment without the switch refuses the session with one configuration message', async () => {
    config.KORTIX_PLATINUM_RESIDENTIAL_PROXY = false;
    const failure = await refusal(() => resolveSessionResidentialProxy({ country: 'us' }, 'platinum'));
    expect(failure).toMatchObject({ category: 'sandbox-provider', transient: false, isCapacity: false });
    expect(failure.userMessage).toStartWith(
      'This sandbox template asks for a residential IP, which this deployment does not offer',
    );
  });

  test('fail closed: another provider refuses the session', async () => {
    const failure = await refusal(() => resolveSessionResidentialProxy({}, 'daytona'));
    expect(failure).toMatchObject({ category: 'sandbox-provider', transient: false });
    expect(failure.userMessage).toContain("this session's sandbox provider is not Platinum");
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
