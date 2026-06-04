import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { applyScaffold } from '../scaffold';

let dir: string;

// The full Kortix OpenCode runtime ships as editable SOURCE in the base starter
// (self-contained — clone + run opencode locally works). Simplifications kept:
// no `app/`, a single `.kortix/memory/MEMORY.md` seed (no stub sub-files). The
// general-knowledge-worker template adds its skill pack on top. (Updates will be
// managed via the Kortix registry later — see the registry plan.)
const BASE_STARTER_PATHS = [
  '.gitignore',
  '.kortix/memory/MEMORY.md',
  '.kortix/opencode/agents/kortix.md',
  '.kortix/opencode/agents/memory-reflector.md',
  '.kortix/opencode/bun.lock',
  '.kortix/opencode/opencode.jsonc',
  '.kortix/opencode/package.json',
  '.kortix/opencode/pty/opencode-pty/index.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/constants.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/buffer.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/formatters.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/manager.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/notification-manager.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/output-manager.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/permissions.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/session-lifecycle.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/tools/kill.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/tools/kill.txt',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/tools/list.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/tools/list.txt',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/tools/read.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/tools/read.txt',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/tools/spawn.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/tools/spawn.txt',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/tools/write.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/tools/write.txt',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/types.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/utils.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/pty/wildcard.ts',
  '.kortix/opencode/pty/opencode-pty/src/plugin/types.ts',
  '.kortix/opencode/pty/opencode-pty/src/shared/constants.ts',
  '.kortix/opencode/pty/pty-tools.ts',
  '.kortix/opencode/skills/agent-browser/SKILL.md',
  '.kortix/opencode/skills/kortix-executor/SKILL.md',
  '.kortix/opencode/skills/kortix-memory/SKILL.md',
  '.kortix/opencode/skills/kortix-system/SKILL.md',
  '.kortix/opencode/skills/kortix-system/references/kortix/change-requests.md',
  '.kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md',
  '.kortix/opencode/skills/kortix-system/references/kortix/kortix-toml.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/agents.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/commands.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/mcp-servers.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/models.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/overview.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/permissions.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/plugins.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/rules.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/skills.md',
  '.kortix/opencode/skills/kortix-system/references/opencode/tools.md',
  '.kortix/opencode/skills/kortix-slack/SKILL.md',
  '.kortix/opencode/tools/image_search.ts',
  '.kortix/opencode/tools/lib/get-env.ts',
  '.kortix/opencode/tools/lib/runtime-gate.ts',
  '.kortix/opencode/tools/memory.ts',
  '.kortix/opencode/tools/scrape_webpage.ts',
  '.kortix/opencode/tools/show.ts',
  '.kortix/opencode/tools/web_search.ts',
  'README.md',
  'kortix.toml',
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-scaffold-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function walk(root: string, relPrefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel.split(sep).join('/'));
  }
  return out.sort();
}

describe('applyScaffold', () => {
  test('writes the full Kortix starter into a fresh directory', () => {
    const result = applyScaffold({ repoRoot: dir, projectName: 'Hello World' });

    for (const path of BASE_STARTER_PATHS) expect(result.written).toContain(path);
    expect(result.written).toContain('.kortix/opencode/skills/GENERAL-KNOWLEDGE-WORKER/account-research/SKILL.md');
    expect(result.written).toContain('.kortix/opencode/skills/GENERAL-KNOWLEDGE-WORKER/audit-support/SKILL.md');
    expect(result.written).toContain('.kortix/opencode/skills/GENERAL-KNOWLEDGE-WORKER/content-creation/SKILL.md');
    expect(result.skipped).toEqual([]);

    // Same files now exist on disk.
    expect(walk(dir)).toEqual(result.written.sort());

    // `{{projectName}}` was substituted.
    const manifest = readFileSync(join(dir, 'kortix.toml'), 'utf8');
    expect(manifest).toContain('name = "Hello World"');
    expect(manifest).not.toContain('{{projectName}}');

    // Manifest declares the opencode config dir explicitly. No active
    // `[sandbox]` table is pre-seeded (a commented `# [sandbox]` example is fine).
    expect(manifest).not.toMatch(/^\[sandbox\]/m);
    expect(manifest).toContain('config_dir = ".kortix/opencode"');

    // The full core ships as source (self-contained) — tools, skills, agents.
    expect(result.written).toContain('.kortix/opencode/tools/show.ts');
    expect(result.written).toContain('.kortix/opencode/skills/kortix-system/SKILL.md');
    expect(result.written).toContain('.kortix/opencode/agents/kortix.md');
    // The persona is interpolated with the project name.
    expect(readFileSync(join(dir, '.kortix/opencode/agents/kortix.md'), 'utf8')).toContain('Hello World');
    // Simplifications kept: no app/, single memory seed (no stub sub-files).
    expect(result.written.some((p) => p.startsWith('app/'))).toBe(false);
    expect(result.written).not.toContain('.kortix/memory/overview.md');
  });

  test('minimal template writes only the shared Kortix starter', () => {
    const result = applyScaffold({ repoRoot: dir, projectName: 'Minimal', template: 'minimal' });

    expect(result.written.sort()).toEqual([...BASE_STARTER_PATHS].sort());
    expect(result.written).not.toContain('.kortix/opencode/skills/GENERAL-KNOWLEDGE-WORKER/account-research/SKILL.md');
    expect(walk(dir)).toEqual([...BASE_STARTER_PATHS].sort());
  });

  test('preserveExisting leaves prior files alone, fills in the rest', () => {
    // Pre-seed shipped files we expect to be preserved.
    mkdirSync(join(dir, '.kortix/opencode/agents'), { recursive: true });
    writeFileSync(join(dir, '.kortix/opencode/agents/kortix.md'), 'CUSTOM PERSONA', 'utf8');
    writeFileSync(join(dir, 'README.md'), 'CUSTOM README', 'utf8');

    const result = applyScaffold({
      repoRoot: dir,
      projectName: 'Preserved',
      preserveExisting: true,
    });

    expect(result.skipped.sort()).toEqual(['.kortix/opencode/agents/kortix.md', 'README.md']);
    expect(result.written).toContain('kortix.toml');
    expect(result.written).toContain('.kortix/memory/MEMORY.md');

    expect(readFileSync(join(dir, '.kortix/opencode/agents/kortix.md'), 'utf8')).toBe('CUSTOM PERSONA');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('CUSTOM README');
  });

  test('without preserveExisting, overwrites prior files', () => {
    writeFileSync(join(dir, 'README.md'), 'CUSTOM README', 'utf8');

    const result = applyScaffold({ repoRoot: dir, projectName: 'Overwrite' });

    expect(result.skipped).toEqual([]);
    expect(result.written).toContain('README.md');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).not.toBe('CUSTOM README');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('Overwrite');
  });
});
