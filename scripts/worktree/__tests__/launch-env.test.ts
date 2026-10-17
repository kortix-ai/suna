import { afterEach, describe, expect, test } from 'bun:test';
import { apiLaunchEnv, gatewayLaunchEnv, webLaunchEnv } from '../lib/launch-env';
import { computePorts } from '../lib/ports';
import { slotCredsFromStatus } from '../lib/supabase';

const ports = computePorts(0);
const creds = slotCredsFromStatus(ports, {});
const names = ['INTERNAL_KORTIX_ENV', ...['API', 'WEB'].flatMap(app => ['', '_DEV', '_STAGING'].map(suffix => `SUNA_${app}_DOTENV_PRIVATE_KEY${suffix}`))];
const original = names.map(name => process.env[name]);
afterEach(() => names.forEach((name, index) => {
  const value = original[index];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}));

describe('cold sandbox launch environment', () => {
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
