import { describe, expect, test } from 'bun:test';

import { MIGRATE_TO_V3_PROMPT } from './migration-prompt';

describe('MIGRATE_TO_V3_PROMPT — the upgrade session contract', () => {
  test('targets kortix_version 3 from v1 and v2, and stops on v3', () => {
    expect(MIGRATE_TO_V3_PROMPT).toContain('kortix_version 3 (kortix.yaml)');
    expect(MIGRATE_TO_V3_PROMPT).toContain('kortix_version 1 is `kortix.toml`, 2 and 3 are `kortix.yaml`');
    expect(MIGRATE_TO_V3_PROMPT).toContain('On kortix_version 3 there is nothing to upgrade');
  });

  test('converts with kortix migrate: preview first, then --write', () => {
    const preview = MIGRATE_TO_V3_PROMPT.indexOf('Run `kortix migrate`.');
    const write = MIGRATE_TO_V3_PROMPT.indexOf('Run `kortix migrate --write`.');
    expect(preview).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(preview);
    expect(MIGRATE_TO_V3_PROMPT).toContain('Not carried over');
    expect(MIGRATE_TO_V3_PROMPT).toContain('kortix schema --version 3');
  });

  test('refreshes the marketplace baseline before the conversion, outside the CR', () => {
    const refresh = MIGRATE_TO_V3_PROMPT.indexOf('kortix marketplace update --all');
    expect(refresh).toBeGreaterThan(-1);
    expect(MIGRATE_TO_V3_PROMPT.indexOf('Run `kortix migrate`.')).toBeGreaterThan(refresh);
    expect(MIGRATE_TO_V3_PROMPT).toMatch(/commits directly to `main`/);
    expect(MIGRATE_TO_V3_PROMPT).toContain('orphaned');
  });

  test('checks grants, the default agent, the old folders and OpenCode-only extensions', () => {
    expect(MIGRATE_TO_V3_PROMPT).toContain('deny-by-default');
    expect(MIGRATE_TO_V3_PROMPT).toContain("from every agent's `extensions` grant");
    expect(MIGRATE_TO_V3_PROMPT).toContain('workspace: { project_repository: true }');
    expect(MIGRATE_TO_V3_PROMPT).toContain('default_agent');
    expect(MIGRATE_TO_V3_PROMPT).toContain('git mv .kortix/memory memory');
    expect(MIGRATE_TO_V3_PROMPT).toContain("git grep -n -e '.kortix/opencode' -e '.kortix/memory' -e 'harnesses/'");
  });

  test('validates, pushes, then opens a change request and never merges', () => {
    expect(MIGRATE_TO_V3_PROMPT).toContain('kortix validate');
    const push = MIGRATE_TO_V3_PROMPT.indexOf('git push origin HEAD');
    const open = MIGRATE_TO_V3_PROMPT.indexOf('kortix cr open');
    expect(push).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(push);
    expect(MIGRATE_TO_V3_PROMPT).toContain('kortix cr diff');
    expect(MIGRATE_TO_V3_PROMPT).toContain('do not open a second one');
    expect(MIGRATE_TO_V3_PROMPT).toContain('Do **not** run `kortix cr merge`');
    expect(MIGRATE_TO_V3_PROMPT).toContain('--force-with-lease');
  });

  test('section numbering is unique and sequential', () => {
    const numbers = [...MIGRATE_TO_V3_PROMPT.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });
});
