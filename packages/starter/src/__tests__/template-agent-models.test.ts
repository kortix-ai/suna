import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { DEFAULT_MANAGED_MODEL_IDS, isManagedModelId } from '@kortix/llm-catalog';

const TEMPLATES_ROOT = join(import.meta.dir, '..', '..', 'templates');

interface AgentModelDeclaration {
  path: string;
  model: string;
}

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

function agentDefinitionFiles(): string[] {
  return walk(TEMPLATES_ROOT)
    .filter((abs) => abs.endsWith('.md'))
    .filter((abs) => {
      const parts = relative(TEMPLATES_ROOT, abs).split(sep);
      return parts.at(-2) === 'agents';
    })
    .sort();
}

function frontmatterModel(content: string): string | undefined {
  if (!content.startsWith('---\n')) return undefined;
  const end = content.indexOf('\n---', 4);
  if (end < 0) return undefined;
  const frontmatter = content.slice(4, end);
  for (const line of frontmatter.split('\n')) {
    const match = /^model:[ \t]*(.+?)[ \t]*$/.exec(line);
    if (match) return match[1].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

function declaredAgentModels(): AgentModelDeclaration[] {
  const out: AgentModelDeclaration[] = [];
  for (const abs of agentDefinitionFiles()) {
    const model = frontmatterModel(readFileSync(abs, 'utf8'));
    if (model) out.push({ path: relative(TEMPLATES_ROOT, abs).split(sep).join('/'), model });
  }
  return out;
}

function resolvesToManagedModel(model: string): boolean {
  const bare = model.startsWith('kortix/') ? model.slice('kortix/'.length) : model;
  return isManagedModelId(bare);
}

describe('starter template agent model declarations', () => {
  test('finds the agent definition files it is supposed to guard', () => {
    const files = agentDefinitionFiles();

    // The floor was `> 50` while `templates/marketplace/` shipped 60 use-case
    // agent personas. That library was removed with the marketplace, so the
    // real floor is the base template's own three agents. The guard below
    // (every declared model resolves to a managed catalog id) is what this file
    // is for; this assertion only proves the walk still finds them.
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.some((f) => f.endsWith('templates/base/.kortix/opencode/agents/kortix.md'))).toBe(
      true,
    );
    expect(
      files.some((f) =>
        f.endsWith('templates/base/.kortix/opencode/agents/harness-reflector.md'),
      ),
    ).toBe(true);
  });

  test('every declared model resolves to a real managed catalog id', () => {
    const invalid = declaredAgentModels()
      .filter((d) => !resolvesToManagedModel(d.model))
      .map((d) => `${d.path} -> ${d.model}`);

    expect({
      invalid,
      managedIds: DEFAULT_MANAGED_MODEL_IDS,
    }).toEqual({ invalid: [], managedIds: DEFAULT_MANAGED_MODEL_IDS });
  });

  test('first-party template agents pin no model and inherit the platform default', () => {
    expect(declaredAgentModels()).toEqual([]);
  });

  test('rejects a provider-qualified inner id under the kortix provider', () => {
    expect(resolvesToManagedModel('kortix/anthropic/claude-sonnet-5')).toBe(false);
    expect(resolvesToManagedModel('kortix/codex/gpt-5.5')).toBe(false);
  });

  test('accepts every managed catalog id in both bare and kortix-prefixed form', () => {
    for (const id of DEFAULT_MANAGED_MODEL_IDS) {
      expect(resolvesToManagedModel(id)).toBe(true);
      expect(resolvesToManagedModel(`kortix/${id}`)).toBe(true);
    }
  });

  test('parses the frontmatter model key it relies on', () => {
    expect(frontmatterModel('---\nmode: primary\nmodel: kortix/glm-5.3-flash\n---\nbody\n')).toBe(
      'kortix/glm-5.3-flash',
    );
    expect(frontmatterModel('---\nmode: primary\n---\nbody\n')).toBeUndefined();
    expect(frontmatterModel('# not frontmatter\nmodel: kortix/glm-5.3-flash\n')).toBeUndefined();
    expect(frontmatterModel('---\nmodel: "kortix/glm-5.3-flash"\n---\n')).toBe('kortix/glm-5.3-flash');
  });
});
