import { afterEach, describe, expect, test } from 'bun:test';
import { apiLaunchEnv, gatewayLaunchEnv, webLaunchEnv } from '../lib/launch-env';
import { computePorts } from '../lib/ports';
import { slotCredsFromStatus } from '../lib/supabase';

const ports = computePorts(0);
const creds = slotCredsFromStatus(ports, {});
const names = ['INTERNAL_KORTIX_ENV', ...['API', 'WEB'].flatMap(app => ['', '_DEV', '_STAGING'].map(suffix => `SUNA_${app}_DOTENV_PRIVATE_KEY${suffix}`)), 'KORTIX_WORKERS_ENABLED'];
const original = names.map(name => process.env[name]);
afterEach(() => names.forEach((name, index) => {
  const value = original[index];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}));

describe('cold sandbox launch environment', () => {
  test('branch databases default to API-only and skip provider snapshot prebuilds', () => {
    delete process.env.KORTIX_WORKERS_ENABLED;
    const env = apiLaunchEnv(ports, creds, { dbMode: 'branch' });
    expect(env.KORTIX_WORKERS_ENABLED).toBe('false');
    expect(env.KORTIX_SKIP_STARTUP_PREBUILD).toBe('true');
  });
  test('branch background workers require an explicit opt-in', () => {
    process.env.KORTIX_WORKERS_ENABLED = 'true';
    const env = apiLaunchEnv(ports, creds, { dbMode: 'branch' });
    expect(env.KORTIX_WORKERS_ENABLED).toBe('true');
    expect(env.KORTIX_SKIP_STARTUP_PREBUILD).toBeUndefined();
  });
  test('an explicit worker kill switch applies to every database mode', () => {
    process.env.KORTIX_WORKERS_ENABLED = 'false';
    for (const dbMode of ['shared', 'branch', 'isolated'] as const) {
      expect(apiLaunchEnv(ports, creds, { dbMode }).KORTIX_WORKERS_ENABLED).toBe('false');
      expect(apiLaunchEnv(ports, creds, { dbMode }).KORTIX_SKIP_STARTUP_PREBUILD).toBe('true');
    }
  });
  test('shared and isolated databases preserve worker-enabled defaults', () => {
    delete process.env.KORTIX_WORKERS_ENABLED;
    for (const dbMode of ['shared', 'isolated'] as const) {
      expect(apiLaunchEnv(ports, creds, { dbMode }).KORTIX_WORKERS_ENABLED).toBe('true');
    }
  });
  test('all services default to dev without an invoking deployment environment', () => {
    delete process.env.INTERNAL_KORTIX_ENV;
    for (const env of [apiLaunchEnv(ports, creds), webLaunchEnv(ports, creds), gatewayLaunchEnv(ports)]) {
      expect(env.INTERNAL_KORTIX_ENV).toBe('dev');
    }
  });
  test('preserves the invoking deployment environment', () => {
    process.env.INTERNAL_KORTIX_ENV = 'staging';
    for (const env of [apiLaunchEnv(ports, creds), webLaunchEnv(ports, creds), gatewayLaunchEnv(ports)]) {
      expect(env.INTERNAL_KORTIX_ENV).toBe('staging');
    }
  });
  test('each app receives only its own local, dev and staging decryption keys', () => {
    for (const app of ['API', 'WEB']) {
      for (const suffix of ['', '_DEV', '_STAGING']) process.env[`SUNA_${app}_DOTENV_PRIVATE_KEY${suffix}`] = `${app}${suffix}-synthetic-key`;
    }
    for (const [app, env] of [['API', apiLaunchEnv(ports, creds)], ['WEB', webLaunchEnv(ports, creds)]] as const) {
      for (const suffix of ['', '_DEV', '_STAGING']) expect(env[`DOTENV_PRIVATE_KEY${suffix}`]).toBe(`${app}${suffix}-synthetic-key`);
    }
    expect(gatewayLaunchEnv(ports).DOTENV_PRIVATE_KEY).toBeUndefined();
  });
  test('absent app secrets leave workstation dotenvx key discovery intact', () => {
    for (const name of names.slice(1)) delete process.env[name];
    for (const env of [apiLaunchEnv(ports, creds), webLaunchEnv(ports, creds)]) {
      for (const suffix of ['', '_DEV', '_STAGING']) expect(Object.hasOwn(env, `DOTENV_PRIVATE_KEY${suffix}`)).toBe(false);
    }
  });
});
