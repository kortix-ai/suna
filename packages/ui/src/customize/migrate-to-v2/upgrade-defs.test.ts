import { describe, expect, test } from 'bun:test';

import { MIGRATE_TO_V2_PROMPT } from './migration-prompt';
import { PROJECT_UPGRADES, applicableUpgrades, buildOneOffUpgradePrompt } from './upgrade-defs';

describe('PROJECT_UPGRADES registry', () => {
  test('the v2 migration applies to v1 projects only', () => {
    expect(applicableUpgrades({ manifestVersion: 1 }).map((u) => u.id)).toContain('manifest-v2');
    expect(applicableUpgrades({ manifestVersion: 2 }).map((u) => u.id)).not.toContain(
      'manifest-v2',
    );
  });

  test('an unresolved manifest read applies nothing — no premature offers', () => {
    expect(applicableUpgrades({ manifestVersion: null })).toHaveLength(0);
  });

  test('the v2 entry carries the real migration prompt, not a copy', () => {
    const entry = PROJECT_UPGRADES.find((u) => u.id === 'manifest-v2');
    expect(entry?.prompt).toBe(MIGRATE_TO_V2_PROMPT);
  });

  test('every registry entry is fully described', () => {
    for (const u of PROJECT_UPGRADES) {
      expect(u.id.length).toBeGreaterThan(0);
      expect(u.title.length).toBeGreaterThan(0);
      expect(u.description.length).toBeGreaterThan(0);
      expect(u.prompt.length).toBeGreaterThan(100);
    }
  });
});

describe('buildOneOffUpgradePrompt — the freeform runner wrapper', () => {
  const prompt = buildOneOffUpgradePrompt('Rename the release-bot agent to deploy-bot');

  test('embeds the user request verbatim', () => {
    expect(prompt).toContain('Rename the release-bot agent to deploy-bot');
  });

  test('enforces the full landing contract — push, open, verify, never merge', () => {
    expect(prompt).toContain('git push origin HEAD');
    expect(prompt).toContain('kortix cr open');
    expect(prompt).toContain('kortix cr diff');
    expect(prompt).toMatch(/do not run `kortix cr merge`/i);
  });

  test('syncs with an advanced base before landing', () => {
    expect(prompt).toContain('git fetch origin');
    expect(prompt.toLowerCase()).toContain('rebase');
  });

  test('forbids opening an empty CR when there is nothing to do', () => {
    expect(prompt.toLowerCase()).toContain('do not open an empty change request');
  });

  test('validates manifest edits before landing', () => {
    expect(prompt).toContain('kortix validate');
  });
});
