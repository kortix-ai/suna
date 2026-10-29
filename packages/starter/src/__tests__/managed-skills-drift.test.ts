import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { validateManifest } from '@kortix/manifest-schema';

// The managed skills are the docs every session agent reads, and the API MCP
// serves them to outside clients too. This test fails when their text drifts
// from the code: a manifest example that is not v3, a CLI command or feature
// flag that does not exist, a retired runtime or provider, or a kortix-system
// that outgrows its budget. Static: it reads files and runs nothing.

const TEMPLATES = join(import.meta.dir, '..', '..', 'templates');
const REPO = join(import.meta.dir, '..', '..', '..', '..');
const MANAGED = join(TEMPLATES, 'managed', 'skills');
const SKILL_ROOTS = [MANAGED, join(TEMPLATES, 'base', 'skills', 'kortix-cli')];

function walk(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const abs = join(root, entry);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  });
}

const SKILL_FILES = SKILL_ROOTS.flatMap(walk)
  .filter((abs) => abs.endsWith('.md'))
  .sort()
  .map((abs) => ({ path: relative(TEMPLATES, abs).split(sep).join('/'), text: readFileSync(abs, 'utf8') }));

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;
const readRepo = (path: string) => readFileSync(join(REPO, path), 'utf8');

// Other packages' sources are read as text: the starter does not depend on the CLI or the API.
function cliCommands(): Set<string> {
  const names = new Set<string>();
  for (const m of readRepo('apps/cli/src/command-table.ts').matchAll(/\bname:\s*'([a-z][a-z0-9-]*)'/g)) names.add(m[1]);
  // Aliases (`kortix skills`, `kortix remind`, …) dispatch through COMMAND_HANDLERS.
  const index = readRepo('apps/cli/src/index.ts');
  const start = index.indexOf('const COMMAND_HANDLERS');
  const handlers = index.slice(start, index.indexOf('\n};', start));
  for (const m of handlers.matchAll(/^\s+'?([a-z][a-z0-9-]*)'?:\s*\(/gm)) names.add(m[1]);
  return names;
}

function featureFlagKeys(): Set<string> {
  const registry = readRepo('apps/api/src/feature-flags/registry.ts');
  return new Set([...registry.matchAll(/^\s*key:\s*'([a-z][a-z0-9_]*)',/gm)].map((m) => m[1]));
}

interface CodeBlock {
  body: string;
  line: number;
}

function codeBlocks(text: string): CodeBlock[] {
  const out: CodeBlock[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})/.exec(lines[i]);
    if (!open) continue;
    const [, indent, fence] = open;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[j]);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break;
      body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j].trimStart());
    }
    out.push({ body: body.join('\n'), line: i + 1 });
    i = j;
  }
  return out;
}

// A retired runtime, manifest version or sandbox provider. Every session runs
// pi, new projects are kortix_version 3, and Platinum is the only provider.
const RETIRED_TERMS: ReadonlyArray<{ term: string; pattern: RegExp }> = [
  { term: 'opencode', pattern: /opencode/gi },
  { term: 'harnesses/opencode', pattern: /harnesses\/opencode/gi },
  { term: 'kortix.toml', pattern: /kortix\.toml/gi },
  { term: 'kortix_version: 1', pattern: /kortix_version:\s*1\b/gi },
  { term: 'kortix_version: 2', pattern: /kortix_version:\s*2\b/gi },
  { term: 'daytona', pattern: /daytona/gi },
  { term: 'e2b', pattern: /\be2b\b/gi },
];

// A phrase that names a retired term on purpose. It is cut from the text before the scan.
const ALLOWED_PHRASES: ReadonlyArray<{ phrase: RegExp; reason: string }> = [
  {
    phrase: /\bOpenCode (?:Zen|Go)\b/gi,
    reason: 'OpenCode Zen and OpenCode Go are model providers a project connects; their product names stay.',
  },
];

describe('managed skills drift', () => {
  test('finds the skills it guards', () => {
    const skills = SKILL_FILES.filter((f) => f.path.endsWith('/SKILL.md')).map((f) => f.path);
    expect(skills.length).toBeGreaterThanOrEqual(19);
    expect(skills).toContain('base/skills/kortix-cli/SKILL.md');
    expect(skills).toContain('managed/skills/kortix-system/SKILL.md');
  });

  test('every manifest example with kortix_version validates as v3', () => {
    const invalid: string[] = [];
    for (const file of SKILL_FILES) {
      for (const block of codeBlocks(file.text)) {
        if (!/^kortix_version\s*:/m.test(block.body)) continue;
        const result = validateManifest(block.body, 'yaml');
        const errors = result.issues.filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`);
        if (result.parsed?.kortix_version !== 3) errors.unshift('not kortix_version 3');
        if (errors.length > 0) invalid.push(`${file.path}:${block.line} ${errors.join('; ')}`);
      }
    }
    expect(invalid).toEqual([]);
  });

  test('every `kortix <command>` exists in the CLI', () => {
    const commands = cliCommands();
    expect(commands.has('sessions')).toBe(true);
    expect(commands.has('skills')).toBe(true);
    const unknown: string[] = [];
    for (const file of SKILL_FILES) {
      // One space after `kortix`: a wider gap is a table column, not a command.
      for (const m of file.text.matchAll(/(?<![\w./@$-])kortix ([a-z][a-z0-9-]*)(?![\w:])/g)) {
        if (!commands.has(m[1])) unknown.push(`${file.path}:${lineOf(file.text, m.index)} kortix ${m[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  test('every feature flag a skill names is in the registry', () => {
    const keys = featureFlagKeys();
    expect(keys.has('reminders')).toBe(true);
    const mentions = [
      /kortix-feature-flag:\s*([a-z][a-z0-9_]*)/g,
      /features\s+(?:enable|disable)\s+([a-z][a-z0-9_]*)/g,
      /`([a-z][a-z0-9_]*)`\s+(?:feature\s+|project\s+)?flags?\b/g,
      /\bflags?\s+`([a-z][a-z0-9_]*)`/g,
    ];
    const unknown: string[] = [];
    for (const file of SKILL_FILES) {
      for (const pattern of mentions) {
        for (const m of file.text.matchAll(pattern)) {
          if (!keys.has(m[1])) unknown.push(`${file.path}:${lineOf(file.text, m.index)} ${m[1]}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  test('no skill names a retired runtime, manifest version or sandbox provider', () => {
    const hits: string[] = [];
    for (const file of SKILL_FILES) {
      const text = ALLOWED_PHRASES.reduce((t, a) => t.replace(a.phrase, (s) => ' '.repeat(s.length)), file.text);
      for (const { term, pattern } of RETIRED_TERMS) {
        for (const m of text.matchAll(pattern)) hits.push(`${file.path}:${lineOf(text, m.index)} ${term}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test('kortix-system stays within its budget', () => {
    const lines = (text: string) => (text.match(/\n/g) ?? []).length;
    const system = SKILL_FILES.filter((f) => f.path.startsWith('managed/skills/kortix-system/'));
    const skill = system.find((f) => f.path.endsWith('/SKILL.md'));
    expect(skill).toBeDefined();
    expect(lines(skill?.text ?? '')).toBeLessThanOrEqual(300);
    expect(system.reduce((sum, f) => sum + lines(f.text), 0)).toBeLessThanOrEqual(1500);
  });
});
