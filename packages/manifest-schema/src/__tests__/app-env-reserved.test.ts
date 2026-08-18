/**
 * `kortix validate` must refuse exactly the App env names that deploy refuses.
 *
 * WHY THIS FILE EXISTS
 *
 * These two checks lived in different packages and drifted. The validator
 * accepted any uppercase name; the API refused reserved ones when it built the
 * deployment environment. So a `kortix.yaml` setting `KORTIX_API_KEY` passed
 * `kortix validate` and failed at deploy — and the version that eventually
 * shipped without those variables did not error at all, because the feature
 * that read them just rendered nothing. The App looked fine and was missing a
 * whole panel.
 *
 * The rule now lives in `constants.ts` and `apps/api` imports it. These tests
 * are what stop someone adding a name to one side only.
 */

import { describe, expect, test } from 'bun:test';
import {
  isReservedEnvName,
  NEVER_DELIVERED_ENV_NAMES,
  RESERVED_ENV_NAME_PREFIXES,
  RESERVED_ENV_NAMES,
  reservedEnvNameReason,
  validateManifest,
} from '../index.ts';

/**
 * A complete, otherwise-valid v2 manifest with one App — `apps:` is a v2
 * section, and the App's fields are copied from `essentia-kortix/kortix.yaml`,
 * the manifest whose `KORTIX_*` names validated clean and then failed to
 * deploy.
 */
function appManifest(env: Record<string, string>, key: 'env' | 'secrets' = 'env'): string {
  const block = Object.entries(env)
    .map(([name, value]) => `      ${name}: ${JSON.stringify(value)}`)
    .join('\n');

  return `
kortix_version: 2
default_agent: support
runtime: opencode

project:
  name: acme
  description: Fixture

agents:
  support: {}

apps:
  dashboards:
    type: dockerfile
    dockerfile: Dockerfile
    command:
      - ./docker-entrypoint.sh
    port: 3000
    ${key}:
${block}
`;
}

function errors(input: string): string[] {
  // 'yaml' explicitly: `validateManifest` defaults to TOML, and v2 manifests
  // are YAML-only.
  return validateManifest(input, 'yaml')
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => `${issue.path}: ${issue.message}`);
}

describe('reserved App environment names', () => {
  test('the platform prefixes are refused by validate, not only by deploy', () => {
    for (const prefix of RESERVED_ENV_NAME_PREFIXES) {
      const name = `${prefix}API_KEY`;
      const found = errors(appManifest({ [name]: 'x' }));
      expect(found.some((message) => message.includes(name)), name).toBe(true);
    }
  });

  test('the message says what to do, not merely that it is wrong', () => {
    // An author who reads "is reserved" and nothing else renames it to
    // something else reserved. The one that bit us is worth naming exactly.
    const [message] = errors(appManifest({ KORTIX_API_KEY: 'x' }));
    expect(message).toContain('KORTIX_');
    expect(message).toMatch(/rename/i);
  });

  test('names the runtime sets itself are refused', () => {
    for (const name of ['PORT', 'PATH', 'NODE_ENV', 'LD_PRELOAD']) {
      expect(RESERVED_ENV_NAMES.has(name), name).toBe(true);
      expect(errors(appManifest({ [name]: '3000' })).length, name).toBeGreaterThan(0);
    }
  });

  test('secrets are checked on the same rule as plain values', () => {
    // `secrets:` maps an env name to a project-secret identifier. The
    // DESTINATION is still an env name, so the same names are illegal — and
    // this half was the one actually used in the manifest that failed.
    expect(errors(appManifest({ KORTIX_API_KEY: 'SOME_SECRET' }, 'secrets')).length).toBeGreaterThan(0);
  });

  test('secrets the platform never delivers are refused up front', () => {
    for (const name of NEVER_DELIVERED_ENV_NAMES) {
      expect(errors(appManifest({ [name]: 'SOME_SECRET' }, 'secrets')).length, name).toBeGreaterThan(0);
    }
  });

  test('an ordinary name is still accepted', () => {
    // The prefixed name we actually shipped with, so the fix cannot have made
    // the working configuration invalid.
    const found = errors(appManifest({
      DASHBOARDS_KORTIX_API_KEY: 'x',
      DASHBOARDS_DATABASE_URL: 'postgres://…',
      PORTAL_URL: 'https://example.com',
    }));
    expect(found).toEqual([]);
  });

  test('a reserved prefix is only reserved at the START of the name', () => {
    // `PORTAL_URL` starts with the letters of `PORT` and must not be caught by
    // the exact-name set; `MY_KORTIX_KEY` contains the prefix but does not
    // start with it.
    expect(isReservedEnvName('PORTAL_URL')).toBe(false);
    expect(isReservedEnvName('MY_KORTIX_KEY')).toBe(false);
    expect(isReservedEnvName('KORTIX_KEY')).toBe(true);
  });

  test('reservedEnvNameReason answers for exactly the names isReservedEnvName refuses', () => {
    for (const name of ['KORTIX_A', 'OPENCODE_B', 'PORT', 'SLACK_BOT_TOKEN', 'FINE_NAME']) {
      expect(reservedEnvNameReason(name) !== null, name).toBe(isReservedEnvName(name));
    }
  });
});
