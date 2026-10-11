/**
 * Integration test (real Postgres): the `volumes` feature flag IS the
 * organization's Volumes switch. Writing it changes the per-organization entry
 * of the `session_boot_modes` policy row (the one Admin → Volumes edits), and
 * the derived `drives` / `ephemeral_sandboxes` flags follow it. The rest of the
 * policy row is left as it was.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

if (!process.env.PLATINUM_API_KEY || process.env.PLATINUM_API_KEY.startsWith('encrypted:')) {
  process.env.PLATINUM_API_KEY = 'pt_test_key';
}

const { sql } = await import('drizzle-orm');
const { db } = await import('../shared/db');
const { BOOT_MODE_SETTING_KEY, bootModePolicy, refreshBootModePolicy } = await import('../platform/services/boot-mode-setting');
const { resolveVolumes } = await import('../platform/services/boot-mode');
const { buildFeatureFlagCatalog, resolveFeatureFlag } = await import('../feature-flags/registry');
const { writeOrganizationFeatureFlag } = await import('../feature-flags/write');

const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222';

let original: unknown;

async function storedValue(): Promise<Record<string, any> | undefined> {
  const rows = (await db.execute(
    sql`select value from kortix.platform_settings where key = ${BOOT_MODE_SETTING_KEY}`,
  )) as unknown as Array<{ value: Record<string, any> }>;
  return rows[0]?.value;
}

beforeAll(async () => {
  original = await storedValue();
  await db.execute(sql`
    insert into kortix.platform_settings (key, value, updated_at)
    values (${BOOT_MODE_SETTING_KEY}, ${JSON.stringify({ killSwitch: true, volumes: { enabled: false, percent: 0, orgs: { [OTHER]: true } } })}::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `);
  await refreshBootModePolicy();
});

afterAll(async () => {
  if (original === undefined) {
    await db.execute(sql`delete from kortix.platform_settings where key = ${BOOT_MODE_SETTING_KEY}`);
  } else {
    await db.execute(sql`update kortix.platform_settings set value = ${JSON.stringify(original)}::jsonb where key = ${BOOT_MODE_SETTING_KEY}`);
  }
});

describe('volumes feature flag ↔ organization Volumes switch', () => {
  test('toggling the flag flips resolveVolumes for that organization and the derived flags follow', async () => {
    const volumesRow = () => buildFeatureFlagCatalog({}, ORG).find((f) => f.key === 'volumes');

    // Default: off, listed as an organization flag with no organization entry.
    expect(resolveFeatureFlag({}, 'volumes', ORG)).toBe(false);
    expect(volumesRow()).toMatchObject({ enabled: false, overridden: false, scope: 'organization', operator_only: false });

    await writeOrganizationFeatureFlag(ORG, 'volumes', true);
    expect(resolveVolumes(bootModePolicy().policy, ORG)).toEqual({ enabled: true, source: 'org' });
    expect(resolveFeatureFlag({}, 'volumes', ORG)).toBe(true);
    expect(resolveFeatureFlag({}, 'drives', ORG)).toBe(true);
    expect(resolveFeatureFlag({}, 'ephemeral_sandboxes', ORG)).toBe(true);
    expect(volumesRow()).toMatchObject({ enabled: true, overridden: true });
    // The same row Admin → Volumes edits; nothing else in it moved.
    const on = await storedValue();
    expect(on?.volumes.orgs).toEqual({ [OTHER]: true, [ORG]: true });
    expect(on?.killSwitch).toBe(true);

    await writeOrganizationFeatureFlag(ORG, 'volumes', false);
    expect(resolveVolumes(bootModePolicy().policy, ORG).enabled).toBe(false);
    expect(resolveFeatureFlag({}, 'drives', ORG)).toBe(false);
    expect(resolveFeatureFlag({ experimental: { ephemeral_sandboxes: true } }, 'ephemeral_sandboxes', ORG)).toBe(false);
    // Another organization is untouched.
    expect(resolveFeatureFlag({}, 'drives', OTHER)).toBe(true);

    // Clearing removes the entry: back to the global switch (off).
    await writeOrganizationFeatureFlag(ORG, 'volumes', null);
    expect((await storedValue())?.volumes.orgs).toEqual({ [OTHER]: true });
    expect(volumesRow()).toMatchObject({ enabled: false, overridden: false });
  });
});
