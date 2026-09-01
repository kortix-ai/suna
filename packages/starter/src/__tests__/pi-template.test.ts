/**
 * The pi starter kit — `kortix_version: 3` plus a `.kortix/pi` config surface.
 *
 * The whole template rests on one JOIN that no file spells out: the manifest's
 * `agents:` map key, the version-derived config dir, and the agent's `.md`
 * filename must agree. Break any one of them and nothing errors — the project
 * scaffolds, the session starts, and the agent silently boots with the
 * runtime's stock prompt instead of the one in this repo. So these tests
 * assert the join itself, not merely that the files exist.
 */
import { describe, expect, test } from 'bun:test';
import {
  type ManifestIssue,
  manifestDefaultConfigDir,
  manifestDefaultRuntime,
  parseManifestText,
  validateAgentMdFrontmatter,
  validateManifest,
} from '@kortix/manifest-schema';
import { STARTER_TEMPLATE_IDS, getStarterFiles } from '../index.ts';

const files = () => getStarterFiles({ projectName: 'Demo Project', template: 'pi' });
const byPath = () => new Map(files().map((f) => [f.path, f.content]));

/** Mirrors `agentMarkdownPath` in apps/api — this package cannot import it. */
function agentMdPath(manifest: Record<string, unknown>, agent: string): string {
  const version = Number(manifest.kortix_version);
  const block = (manifest.pi ?? manifest.opencode) as Record<string, unknown> | undefined;
  const dir =
    typeof block?.config_dir === 'string' && block.config_dir.trim()
      ? block.config_dir.trim().replace(/\/+$/, '')
      : manifestDefaultConfigDir(version);
  return `${dir}/agents/${agent}.md`;
}

describe('pi starter kit', () => {
  test('is a selectable template id', () => {
    expect(STARTER_TEMPLATE_IDS).toContain('pi');
  });

  test('scaffolds a kortix_version 3 manifest that validates clean', () => {
    const raw = byPath().get('kortix.yaml');
    expect(raw).toBeDefined();
    const result = validateManifest(raw!, 'yaml');
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.valid).toBe(true);
    expect((result.parsed as Record<string, unknown>).kortix_version).toBe(3);
  });

  // The point of v3. If someone "helpfully" adds `runtime: pi` back, that is
  // fine — but a v3 manifest that resolves to opencode is a broken template.
  test('needs no `runtime:` line, because v3 already means pi', () => {
    const raw = byPath().get('kortix.yaml')!;
    const manifest = parseManifestText(raw, 'yaml') as Record<string, unknown>;
    expect(manifest.runtime).toBeUndefined();
    expect(manifestDefaultRuntime(Number(manifest.kortix_version))).toBe('pi');
  });

  // THE JOIN: manifest key -> version-derived dir -> file on disk.
  test('every declared agent has its .md at the path the compiler will read', () => {
    const map = byPath();
    const manifest = parseManifestText(map.get('kortix.yaml')!, 'yaml') as Record<string, unknown>;
    const agents = Object.keys(manifest.agents as Record<string, unknown>);
    expect(agents.length).toBeGreaterThan(0);
    for (const name of agents) {
      const path = agentMdPath(manifest, name);
      expect(path.startsWith('.kortix/pi/agents/')).toBe(true);
      expect(map.has(path)).toBe(true);
    }
  });

  test('default_agent names a declared agent', () => {
    const manifest = parseManifestText(byPath().get('kortix.yaml')!, 'yaml') as Record<
      string,
      unknown
    >;
    expect(Object.keys(manifest.agents as Record<string, unknown>)).toContain(
      manifest.default_agent as string,
    );
  });

  test("each agent's frontmatter is valid, and its body is non-empty", () => {
    const map = byPath();
    let checked = 0;
    for (const [path, content] of map) {
      if (!path.startsWith('.kortix/pi/agents/')) continue;
      checked++;
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(content);
      expect(fm).not.toBeNull();
      const issues: ManifestIssue[] = [];
      validateAgentMdFrontmatter(
        parseManifestText(fm![1]!, 'yaml') as Record<string, unknown>,
        path,
        issues,
      );
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
      // The body IS the system prompt (main.ts: `agent.prompt` -> systemPrompt).
      // An empty body silently boots the runtime's stock persona.
      const body = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      expect(body.length).toBeGreaterThan(200);
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('ships no .kortix/opencode — a pi box never starts opencode', () => {
    expect(files().filter((f) => f.path.startsWith('.kortix/opencode/'))).toEqual([]);
  });

  test('still inherits the runtime-agnostic base files', () => {
    const map = byPath();
    expect(map.has('.kortix/memory/MEMORY.md')).toBe(true);
    expect(map.has('README.md')).toBe(true);
    expect(map.has('.gitignore')).toBe(true);
  });

  test('interpolates {{projectName}} everywhere it appears', () => {
    for (const f of files()) expect(f.content).not.toContain('{{projectName}}');
    expect(byPath().get('kortix.yaml')).toContain('Demo Project');
  });

  test('leaves the opencode templates untouched', () => {
    const gkw = getStarterFiles({ projectName: 'D', template: 'general-knowledge-worker' });
    expect(gkw.some((f) => f.path.startsWith('.kortix/opencode/agents/'))).toBe(true);
    expect(gkw.some((f) => f.path.startsWith('.kortix/pi/'))).toBe(false);
    expect(gkw.find((f) => f.path === 'kortix.yaml')?.content).toContain('kortix_version: 2');
  });
});
