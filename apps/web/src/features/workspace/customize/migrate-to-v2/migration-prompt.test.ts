import { describe, expect, test } from 'bun:test';

import { MIGRATE_TO_V2_PROMPT } from './migration-prompt';

describe('MIGRATE_TO_V2_PROMPT — the core migration artifact', () => {
  test('names the target file format', () => {
    expect(MIGRATE_TO_V2_PROMPT).toContain('kortix.yaml');
  });

  test('requires default_agent', () => {
    expect(MIGRATE_TO_V2_PROMPT).toContain('default_agent');
  });

  test('instructs the env → secrets rename', () => {
    expect(MIGRATE_TO_V2_PROMPT).toContain('secrets');
    expect(MIGRATE_TO_V2_PROMPT.toLowerCase()).toContain('renamed');
    expect(MIGRATE_TO_V2_PROMPT).toMatch(/`env`.{0,80}`secrets`/);
  });

  test('instructs leaving agent .md frontmatter untouched — governance-only migration', () => {
    expect(MIGRATE_TO_V2_PROMPT.toLowerCase()).toContain('frontmatter');
    expect(MIGRATE_TO_V2_PROMPT).toContain('agents:');
    expect(MIGRATE_TO_V2_PROMPT.toLowerCase()).toContain('leave every agent');
    expect(MIGRATE_TO_V2_PROMPT).not.toMatch(/hoist/i);
  });

  test('the v2 agent block example (the fenced yaml sample) carries no behavioral fields', () => {
    const start = MIGRATE_TO_V2_PROMPT.indexOf('agents:\n  <name>:');
    expect(start).toBeGreaterThan(-1);
    const end = MIGRATE_TO_V2_PROMPT.indexOf('```', start);
    expect(end).toBeGreaterThan(start);
    const sample = MIGRATE_TO_V2_PROMPT.slice(start, end);
    for (const illegal of ['description:', 'model:', 'opencode:', 'permission:', 'mode:']) {
      expect(sample).not.toContain(illegal);
    }
  });

  test('requires validation before finishing', () => {
    expect(MIGRATE_TO_V2_PROMPT).toContain('kortix validate');
  });

  test('lands as a change request and explicitly forbids merging it', () => {
    expect(MIGRATE_TO_V2_PROMPT).toContain('kortix cr open');
    expect(MIGRATE_TO_V2_PROMPT.toLowerCase()).toContain('never merge');
    expect(MIGRATE_TO_V2_PROMPT).toMatch(/not\*\*.{0,10}run.{0,10}`kortix cr merge`/);
  });

  test('calls out channels removal and the deny-by-default grant change', () => {
    expect(MIGRATE_TO_V2_PROMPT).toContain('channels');
    expect(MIGRATE_TO_V2_PROMPT.toLowerCase()).toContain('deny-by-default');
  });

  test('is a non-trivial, self-contained prompt (not a one-liner)', () => {
    expect(MIGRATE_TO_V2_PROMPT.length).toBeGreaterThan(1000);
  });
});
