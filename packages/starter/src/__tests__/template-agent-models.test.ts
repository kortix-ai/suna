import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseManifestText } from '@kortix/manifest-schema';

const TEMPLATES_ROOT = join(import.meta.dir, '..', '..', 'templates');

type AgentBlocks = Record<string, { model?: unknown }>;

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules') continue;
    const abs = join(root, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

function agentPromptFiles(): string[] {
  return walk(TEMPLATES_ROOT)
    .filter((abs) => abs.endsWith('.md') && relative(TEMPLATES_ROOT, abs).split(sep).at(-2) === 'agents')
    .sort();
}

/** Every agent block the templates ship: the base kortix.yaml and each marketplace template. */
function agentBlocks(): Array<{ where: string; block: { model?: unknown } }> {
  const base = parseManifestText(readFileSync(join(TEMPLATES_ROOT, 'base', 'kortix.yaml'), 'utf8')) as {
    agents?: AgentBlocks;
  };
  const registry = JSON.parse(readFileSync(join(TEMPLATES_ROOT, 'marketplace', 'kortix.registry.json'), 'utf8')) as {
    items: Array<{ name: string; meta?: { template?: { agents?: AgentBlocks } } }>;
  };
  return [
    ...Object.entries(base.agents ?? {}).map(([name, block]) => ({ where: `base/kortix.yaml agents.${name}`, block })),
    ...registry.items.flatMap((item) =>
      Object.entries(item.meta?.template?.agents ?? {}).map(([name, block]) => ({ where: `${item.name} agents.${name}`, block })),
    ),
  ];
}

describe('starter template agents', () => {
  test('finds the prompt files and agent blocks it guards', () => {
    const files = agentPromptFiles();

    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('templates/base/agents/worker.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('templates/marketplace/runtime/agents/flaky-test-triage.md'))).toBe(true);
    expect(agentBlocks().length).toBeGreaterThan(50);
  });

  test('every agent prompt file is the prompt alone: the agent block holds its behavior', () => {
    const withFrontmatter = agentPromptFiles()
      .filter((abs) => readFileSync(abs, 'utf8').startsWith('---'))
      .map((abs) => relative(TEMPLATES_ROOT, abs));

    expect(withFrontmatter).toEqual([]);
  });

  test('first-party agents pin no model and inherit the platform default', () => {
    expect(agentBlocks().filter(({ block }) => block.model !== undefined).map(({ where }) => where)).toEqual([]);
  });
});
