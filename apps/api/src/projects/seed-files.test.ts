import { describe, expect, test } from 'bun:test';
import {
  buildProjectSeedFilesFromItem,
  defaultAgentFromSeedFiles,
} from './seed-files';

// Regression coverage for the "agent-scope model pins silently never apply"
// bug: POST /projects/provision seeds a starter kortix.yaml that declares
// `default_agent: kortix`, but never stamped project.metadata.default_agent
// with it — every session then stored the non-binding 'default' sentinel
// (see sessions.ts createProjectSession), and an agent-scope model pin set on
// 'kortix' was never looked up. This helper extracts the seeded manifest's
// declared default agent so r1.ts's provision route can mirror it into
// project.metadata at creation time, same as PUT /:projectId/default-agent.
describe('defaultAgentFromSeedFiles', () => {
  test('extracts a declared default_agent from the seeded kortix.yaml', () => {
    const files = [
      { path: 'kortix.yaml', content: 'kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix: {}\n' },
    ];
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBe('kortix');
  });

  test('no default_agent declared → null (not every project needs one)', () => {
    const files = [{ path: 'kortix.yaml', content: 'kortix_version: 2\nagents:\n  kortix: {}\n' }];
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBeNull();
  });

  test('falls back to a literal "kortix.yaml" path when manifestPath differs', () => {
    const files = [{ path: 'kortix.yaml', content: 'default_agent: release-bot\n' }];
    expect(defaultAgentFromSeedFiles(files, 'config/kortix.toml')).toBe('release-bot');
  });

  test('no manifest file in the seed list → null, never throws', () => {
    const files = [{ path: 'README.md', content: '# hi' }];
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBeNull();
  });

  test('malformed YAML → null, never throws (project creation must not fail over this)', () => {
    const files = [{ path: 'kortix.yaml', content: ':::not yaml:::\n  - [unclosed' }];
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBeNull();
  });

  test('blank/whitespace-only default_agent is treated as unset', () => {
    const files = [{ path: 'kortix.yaml', content: 'default_agent: "   "\n' }];
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBeNull();
  });

  test('non-string default_agent (malformed manifest) → null, never throws', () => {
    const files = [{ path: 'kortix.yaml', content: 'default_agent: 42\n' }];
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBeNull();
  });
});

describe("buildProjectSeedFilesFromItem", () => {
  test("interpolates the destination name into the Kortix starter project", async () => {
    const seed = await buildProjectSeedFilesFromItem({
      id: "kortix-projects:starter",
      projectName: "Company OS",
      repoFullName: "acme/company-os",
      extraMarketplaceItems: [],
      now: "2026-07-19T00:00:00.000Z",
    });

    expect(
      seed.files.find((file) => file.path === "kortix.yaml")?.content,
    ).toContain('name: "Company OS"');
  });

  test('seeds the SEO Department project with bundled agents, skills, schedules, and memory', async () => {
    const { files, baseFiles } = await buildProjectSeedFilesFromItem({
      id: 'kortix-projects:seo-department',
      projectName: 'Acme SEO',
      repoFullName: 'acme/seo',
      extraMarketplaceItems: [],
      now: '2026-07-21T00:00:00.000Z',
    });
    const paths = new Set(files.map((f) => f.path));
    const basePaths = new Set(baseFiles.map((f) => f.path));
    const manifest = files.find((f) => f.path === 'kortix.yaml')?.content ?? '';

    expect(basePaths.has('.kortix/opencode/skills/kortix-system/SKILL.md')).toBe(true);
    expect(paths.has('.kortix/opencode/skills/kortix-system/SKILL.md')).toBe(true);
    expect(paths.has('.kortix/opencode/agents/seo-director.md')).toBe(true);
    expect(paths.has('.kortix/opencode/agents/technical-seo.md')).toBe(true);
    expect(paths.has('.kortix/opencode/agents/content-strategist.md')).toBe(true);
    expect(paths.has('.kortix/opencode/agents/serp-analyst.md')).toBe(true);
    expect(paths.has('.kortix/opencode/agents/seo-repo-watchdog.md')).toBe(true);
    expect(paths.has('.kortix/opencode/skills/seo-operating-system/SKILL.md')).toBe(true);
    expect(paths.has('.kortix/opencode/skills/technical-seo-audit/SKILL.md')).toBe(true);
    expect(paths.has('.kortix/opencode/skills/seo-repo-monitoring/SKILL.md')).toBe(true);
    expect(paths.has('.kortix/opencode/skills/content-seo-workflow/SKILL.md')).toBe(true);
    expect(paths.has('.kortix/opencode/skills/serp-intelligence/SKILL.md')).toBe(true);
    expect(paths.has('.kortix/memory/SEO.md')).toBe(true);
    expect(manifest).toContain('name: "Acme SEO"');
    expect(manifest).toContain('default_agent: seo-director');
    expect(manifest).toContain('daily-serp-watch');
    expect(manifest).toContain('repo-seo-watch');
    expect(manifest).toContain('daily-repo-seo-sweep');
    expect(manifest).toContain('weekly-technical-audit');
    expect(manifest).toContain('weekly-content-refresh');
    expect(manifest).toContain('monthly-seo-growth-report');
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBe('seo-director');
  });
});
