/**
 * The waiver list for migrations that merged red.
 *
 * Squawk lints file TEXT, and merged migrations are immutable (CI job
 * "Migrations are immutable"). So a finding in a merged migration can never be
 * fixed — not by editing it, not by a follow-up migration. And because squawk's
 * target set is every non-exempt file rather than the ones a PR adds, one red
 * merge fails the lint on every unrelated PR from then on.
 *
 * Hence a waiver. The risk of a waiver list is that it quietly becomes the
 * place findings go to die, so these tests pin the properties that keep it
 * honest: every entry explains itself, it stays separate from the grandfather
 * snapshot, and the lint prints it on every run.
 */
import { describe, expect, test } from 'bun:test';
import { loadWaivers } from './squawk-lint';

const waivers = loadWaivers();
const LINT = await Bun.file(new URL('./squawk-lint.ts', import.meta.url).pathname).text();

describe('squawk-waivers.json', () => {
  test('parses and is non-empty only for real, named files', async () => {
    for (const w of waivers) {
      expect(w.file).toMatch(/^\d{17}_[a-z0-9_]+\.sql$/);
      const exists = await Bun.file(
        new URL(`../migrations/${w.file}`, import.meta.url).pathname,
      ).exists();
      expect(exists).toBe(true);
    }
  });

  test('every entry states what is wrong and why it cannot be fixed', () => {
    // A bare filename would make the list indistinguishable from a mute button.
    for (const w of waivers) {
      expect(typeof w.reason).toBe('string');
      expect(w.reason.length).toBeGreaterThan(40);
      expect(typeof w.unfixableBecause).toBe('string');
    }
  });

  test('no file is both grandfathered and waived', async () => {
    // The two lists mean different things — "predates the policy" versus
    // "violated the policy". An overlap would blur exactly that distinction.
    const gf = (await Bun.file(
      new URL('../grandfathered-migrations.json', import.meta.url).pathname,
    ).json()) as { files: string[] };
    const gfSet = new Set(gf.files);
    for (const w of waivers) expect(gfSet.has(w.file)).toBe(false);
  });
});

describe('squawk-lint waiver handling', () => {
  test('excludes waived files from the lint targets', () => {
    expect(LINT).toContain('waived.has(f)');
  });

  test('prints the waived list on every run', () => {
    // Debt that stops being visible stops being debt and becomes the norm.
    expect(LINT).toContain('WAIVED migration(s)');
  });

  test('keeps the grandfather set as a separate input', () => {
    expect(LINT).toContain('loadGrandfatherSet');
    expect(LINT).toContain('loadWaivers');
  });
});
