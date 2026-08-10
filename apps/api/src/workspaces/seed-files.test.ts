import { describe, expect, test } from 'bun:test';
import { buildWorkspaceSeedFilesFromItem, defaultAgentFromSeedFiles } from './seed-files';

// Regression coverage for the "agent-scope model pins silently never apply"
// bug: POST /projects/provision seeds a starter kortix.yaml that declares
// `default_agent: kortix`, but never stamped project.metadata.default_agent
// with it — every session then stored the non-binding 'default' sentinel
// (see sessions.ts createWorkspaceSession), and an agent-scope model pin set on
// 'kortix' was never looked up. This helper extracts the seeded manifest's
// declared default agent so r1.ts's provision route can mirror it into
// project.metadata at creation time, same as PUT /:workspaceId/default-agent.
describe('defaultAgentFromSeedFiles', () => {
  test('extracts a declared default_agent from the seeded kortix.yaml', () => {
    const files = [
      {
        path: 'kortix.yaml',
        content: 'kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix: {}\n',
      },
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

describe('buildWorkspaceSeedFilesFromItem', () => {
  test('interpolates the destination name into the Kortix starter project', async () => {
    const seed = await buildWorkspaceSeedFilesFromItem({
      id: 'kortix-projects:starter',
      projectName: 'Company OS',
      repoFullName: 'acme/company-os',
      extraMarketplaceItems: [],
      now: '2026-07-19T00:00:00.000Z',
    });

    expect(seed.files.find((file) => file.path === 'kortix.yaml')?.content).toContain(
      'name: "Company OS"',
    );
  });

  test('clones the Use-case pack to conventional in-repo paths', async () => {
    const seed = await buildWorkspaceSeedFilesFromItem({
      id: 'kortix-projects:use-case-pack',
      projectName: 'Ops Pack',
      repoFullName: 'acme/ops-pack',
      extraMarketplaceItems: [],
      now: '2026-08-06T00:00:00.000Z',
    });

    const paths = seed.files.map((f) => f.path);
    // The pack's own README wins over the minimal scaffold's.
    expect(seed.files.find((f) => f.path === 'README.md')?.content).toContain('Use-case pack');
    // Runbook skills + persona agents land where the runtime loads them.
    expect(paths.some((p) => p.startsWith('.kortix/opencode/skills/') && p.endsWith('/SKILL.md'))).toBe(true);
    expect(paths.some((p) => p.startsWith('.kortix/opencode/agents/') && p.endsWith('.md'))).toBe(true);
    // No template-internal `runtime/` paths leak into a cloned repo.
    expect(paths.every((p) => !p.startsWith('runtime/'))).toBe(true);
    // The scaffold still provides the manifest with a declared default agent.
    expect(seed.files.find((f) => f.path === 'kortix.yaml')?.content).toContain('default_agent:');
  });

  /**
   * The bundled department projects (SEO / Marketing / Website Studio) were
   * retired — the marketplace leads with the single Kortix Starter project.
   * What matters now is that asking for a project id that no longer exists
   * FAILS CLEANLY rather than throwing inside project creation.
   */
  test('a retired bundled project id is rejected, not crashed on', async () => {
    await expect(
      buildWorkspaceSeedFilesFromItem({
        id: 'kortix-projects:seo-department',
        projectName: 'Acme SEO',
        repoFullName: 'acme/seo',
        extraMarketplaceItems: [],
        now: '2026-07-21T00:00:00.000Z',
      }),
    ).rejects.toThrow();
  });
});
