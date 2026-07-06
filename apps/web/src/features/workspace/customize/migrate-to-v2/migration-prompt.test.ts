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

  test('points at the canonical schema — CLI command and published URL', () => {
    expect(MIGRATE_TO_V2_PROMPT).toContain('kortix schema --version 2');
    expect(MIGRATE_TO_V2_PROMPT).toContain('https://kortix.com/schema/kortix.v2.schema.json');
  });

  test('lists every v2 clean-break the validator hard-errors on', () => {
    expect(MIGRATE_TO_V2_PROMPT).toContain('per_user');
    expect(MIGRATE_TO_V2_PROMPT).toContain('agent_scope');
    expect(MIGRATE_TO_V2_PROMPT).toContain('project.session.exec');
    expect(MIGRATE_TO_V2_PROMPT).toContain('channel.send');
  });

  test('forbids widening a grant to cover a deleted legacy action', () => {
    expect(MIGRATE_TO_V2_PROMPT).toMatch(/do not substitute a broader grant/i);
  });

  test('carries a worked before/after example in both formats', () => {
    expect(MIGRATE_TO_V2_PROMPT).toContain('```toml');
    const tomlStart = MIGRATE_TO_V2_PROMPT.indexOf('```toml');
    const yamlAfter = MIGRATE_TO_V2_PROMPT.indexOf('```yaml', tomlStart);
    expect(yamlAfter).toBeGreaterThan(tomlStart);
    expect(MIGRATE_TO_V2_PROMPT).toContain('kortix_version = 1');
    expect(MIGRATE_TO_V2_PROMPT).toContain('kortix_version: 2');
  });

  test('the worked v2 example authors none of the removed keys (comments may mention them)', () => {
    const start = MIGRATE_TO_V2_PROMPT.indexOf('becomes this v2');
    expect(start).toBeGreaterThan(-1);
    const end = MIGRATE_TO_V2_PROMPT.indexOf('Note what happened', start);
    expect(end).toBeGreaterThan(start);
    const withoutComments = MIGRATE_TO_V2_PROMPT.slice(start, end)
      .split('\n')
      .map((line) => line.replace(/#.*$/, ''))
      .join('\n');
    for (const removed of ['credential:', 'agent_scope:', 'channels:', 'project.session.exec']) {
      expect(withoutComments).not.toContain(removed);
    }
  });

  test('instructs carrying over hand-written TOML comments', () => {
    expect(MIGRATE_TO_V2_PROMPT.toLowerCase()).toContain('comments');
  });

  test('pushes the branch before opening the CR — an unpushed commit leaves the CR empty', () => {
    expect(MIGRATE_TO_V2_PROMPT).toContain('git push origin HEAD');
    const push = MIGRATE_TO_V2_PROMPT.indexOf('git push origin HEAD');
    const open = MIGRATE_TO_V2_PROMPT.indexOf('kortix cr open');
    expect(push).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(push);
  });

  test('verifies the opened CR is non-empty instead of opening a duplicate', () => {
    expect(MIGRATE_TO_V2_PROMPT).toContain('kortix cr diff');
    expect(MIGRATE_TO_V2_PROMPT.toLowerCase()).toContain('do not open a second one');
  });
});
