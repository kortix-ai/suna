import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FEATURE_FLAG_KEYS } from '@kortix/sdk';

/**
 * The Feature flags page renders `settings.featureFlags.flags.<key>.{name,
 * description}`. A flag registered without them renders MISSING_MESSAGE on the
 * settings page — `agent_principal` shipped that way and only a browser lane
 * caught it. Every registered key needs both strings in every locale.
 */
describe('feature flag translations', () => {
  const dir = join(import.meta.dir, '../../translations');
  const locales = readdirSync(dir).filter((file) => file.endsWith('.json'));

  test('the locale set is not empty', () => {
    expect(locales.length).toBeGreaterThan(0);
  });

  for (const locale of locales) {
    test(`${locale} names and describes every registered flag`, () => {
      const flags = JSON.parse(readFileSync(join(dir, locale), 'utf8'))?.settings?.featureFlags?.flags ?? {};
      const missing = FEATURE_FLAG_KEYS.filter(
        (key) => typeof flags[key]?.name !== 'string' || typeof flags[key]?.description !== 'string',
      );
      expect(missing).toEqual([]);
    });
  }
});
