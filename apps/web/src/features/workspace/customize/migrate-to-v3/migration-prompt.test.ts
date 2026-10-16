import { validateManifest } from '@kortix/manifest-schema';
import { describe, expect, test } from 'bun:test';

import { MIGRATE_TO_V3_PROMPT } from './migration-prompt';

const P = MIGRATE_TO_V3_PROMPT;

/** The text between two markers, with `#` comments removed from every line. */
function codeBetween(start: string, end: string): string {
  const from = P.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = P.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return P.slice(from, to)
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

describe('MIGRATE_TO_V3_PROMPT — the core migration artifact', () => {
  test('targets kortix_version 3 in kortix.yaml, from a v1 or a v2 project', () => {
    expect(P).toContain('kortix_version: 3');
    expect(P).toContain('kortix.yaml');
    expect(P).toContain('kortix.toml');
    expect(P).toContain('kortix_version 2');
  });

  test('the project registers skills, tools, commands and extensions', () => {
    for (const registry of ['skills:', 'tools:', 'commands:', 'extensions:']) {
      expect(codeBetween('## 4.', '## 5.')).toContain(registry);
    }
  });

  test('each agent enables registered things by name: skills, subagents, commands, extensions', () => {
    const shape = codeBetween('## 4.', '## 5.');
    for (const grant of ['skills:', 'subagents:', 'commands:', 'extensions:']) {
      expect(shape).toContain(`    ${grant}`);
    }
  });

  test('says a v3 grant defaults to none, so the migration writes today’s access explicitly', () => {
    expect(P).toMatch(/default(s)? to `none`/);
    expect(P.toLowerCase()).toContain('deny-by-default');
  });

  test('moves behavior into the agent block and the system prompt into prompt_file', () => {
    expect(P).toContain('prompt_file');
    expect(P.toLowerCase()).toContain('frontmatter');
  });

  test('removes every harness folder and harness key — v3 reads none of them', () => {
    expect(P).toContain('harnesses/');
    expect(P).toContain('.kortix/opencode');
    expect(P).toContain('opencode.jsonc');
    expect(P).toMatch(/`git rm -r`/);
    for (const key of ['`opencode`', '`pi`', '`harnesses`', '`permission`']) {
      expect(P).toContain(key);
    }
  });

  test('copies the project-wide default permission into every agent — nothing is global', () => {
    expect(P.toLowerCase()).toContain('nothing is global');
    expect(P).toMatch(/omitted .{0,40}`allow`/i);
  });

  test('declares an OpenCode built-in agent the project relied on, because v3 disables it', () => {
    for (const name of ['build', 'plan', 'general', 'explore']) expect(P).toContain(`\`${name}\``);
  });

  test('never registers a Kortix skill: kortix-* skills are always there', () => {
    expect(P).toContain('kortix-');
    expect(P.toLowerCase()).toContain('always registered');
  });

  test('points at the canonical v3 schema — CLI command and published URL', () => {
    expect(P).toContain('kortix schema --version 3');
    expect(P).toContain('https://kortix.com/schema/kortix.v3.schema.json');
  });

  test('the worked v3 example authors none of the retired keys (comments may mention them)', () => {
    const example = codeBetween('becomes this v3', 'Note what happened');
    // Top level: no harness key and no project-wide permission.
    expect(example).not.toMatch(/^(opencode|pi|harnesses|permission):/m);
    expect(example).not.toContain('config_dir');
    expect(example).not.toContain('kortix:');
    // Agent level: none of the keys v3 refuses.
    const agents = example.slice(example.indexOf('\nagents:'));
    expect(agents).toContain('reviewer:');
    expect(agents).not.toMatch(/^ {4}(file|disable|opencode|harnesses|env|kortix_cli|repository_access):/m);
    expect(example).toContain('kortix_version: 3');
    expect(example).toContain('prompt_file:');
  });

  test('both worked examples pass the real validator: the v2 input and the v3 output', () => {
    const yamlAfter = (marker: string) => {
      const from = P.indexOf('```yaml', P.indexOf(marker)) + '```yaml'.length;
      return P.slice(from, P.indexOf('```', from));
    };
    for (const [marker, version] of [['A representative v2 project', 2], ['becomes this v3', 3]] as const) {
      const result = validateManifest(yamlAfter(marker), 'yaml');
      expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
      expect(result.parsed?.kortix_version).toBe(version);
    }
  });

  test('the v3 agent shape sample carries no file: key', () => {
    expect(codeBetween('## 4.', '## 5.')).not.toMatch(/^\s*file:/m);
  });

  test('requires validation before finishing', () => {
    expect(P).toContain('kortix validate');
  });

  test('lands as a change request and explicitly forbids merging it', () => {
    expect(P).toContain('kortix cr open');
    expect(P.toLowerCase()).toContain('never merge');
    expect(P).toMatch(/not\*\*.{0,10}run.{0,10}`kortix cr merge`/);
  });

  test('pushes the branch before opening the CR — an unpushed commit leaves the CR empty', () => {
    const push = P.indexOf('git push origin HEAD');
    const open = P.indexOf('kortix cr open');
    expect(push).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(push);
  });

  test('verifies the opened CR is non-empty instead of opening a duplicate', () => {
    expect(P).toContain('kortix cr diff');
    expect(P.toLowerCase()).toContain('do not open a second one');
  });

  test('refreshes the marketplace baseline before touching the manifest', () => {
    const refresh = P.indexOf('kortix marketplace update --all');
    expect(P).toContain('kortix marketplace updates');
    expect(refresh).toBeGreaterThan(-1);
    expect(P.indexOf('The v3 shape')).toBeGreaterThan(refresh);
    expect(P).toMatch(/commits directly to `main`/i);
  });

  test('handles an advanced main: rebase, and redo the conversion on conflict rather than reverting', () => {
    expect(P).toContain('git rebase origin/main');
    expect(P).toContain('git rebase --abort');
    expect(P.toLowerCase()).toContain('redo the conversion');
    expect(P).toContain('--force-with-lease');
  });

  test('section numbering is unique and sequential', () => {
    const numbers = [...P.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThan(5);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });
});
