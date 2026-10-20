import { beforeEach, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { parse, stringify } from 'yaml';
import type { ParsedManifest } from '../triggers';
type CommitOptions = Parameters<typeof import('../git/branches').commitMultipleFilesToBranch>[1];
function firstWrite() {
  const write = writes[0];
  if (!write) throw new Error('Missing commit');
  return write;
}
function writtenManifest() {
  const file = firstWrite().files?.[0];
  if (!file) throw new Error('Missing manifest write');
  return parse(file.content);
}
mock.module('../triggers', () => ({ manifestWrites: (manifest: ParsedManifest) => ({ files: [{ path: manifest.path, content: stringify(manifest.raw) }], alsoExpect: [] }) }));

let denied = false;
let workspaceDenied = false;
let skills: Array<{ name: string; path: string }>;
let raw: Record<string, unknown>;
let paths: string[];
let writes: CommitOptions[];
let failure: Error | null;
const project = { projectId: 'test-project', accountId: 'test-account', defaultBranch: 'dev', manifestPath: 'kortix.yaml' };
mock.module('../lib/access', () => ({
  loadProjectForUser: async () => ({ row: project, userId: 'test-user' }),
  assertAgentSessionWorkspaceAllowsRepository: async () => { if (workspaceDenied) throw new Error('workspace denied'); },
  assertProjectCapability: async () => { if (denied) throw new Error('capability denied'); },
}));
mock.module('../lib/git', () => ({ withProjectGitAuth: async () => project }));
mock.module('../git/config', () => ({ loadProjectConfig: async () => ({ skills }) }));
mock.module('../git/files', () => ({
  listRepoFiles: async () => paths.map(path => ({ path, type: 'file' })),
  readRepoFile: async () => '', isRepoFileNotFoundError: () => false,
}));
mock.module('../lib/triggers', () => ({ loadManifestForEdit: async () => ({
  schemaVersion: Number(raw.kortix_version), raw, path: 'kortix.yaml', format: 'yaml', revision: 'abc', commit: 'snapshot',
}) }));
mock.module('../git/branches', () => ({
  GitFileRevisionConflictError: class extends Error {},
  commitFileToBranch: async () => {},
  commitMultipleFilesToBranch: async (_project: unknown, opts: CommitOptions) => { if (failure) throw failure; writes.push(opts); return { commitSha: 'new' }; },
}));
const { projectsApp } = await import('../lib/app');
const { registerProjectSkillsRoutes } = await import('./project-skills');
registerProjectSkillsRoutes();
const app = new OpenAPIHono();
app.route('/projects', projectsApp);
app.onError((err, c) => c.json({ error: err.message }, 403));
const remove = (name = 'Research Notes') => app.request(`/projects/test-project/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
beforeEach(() => {
  denied = workspaceDenied = false;
  failure = null;
  skills = [{ name: 'Research Notes', path: 'skills/research/SKILL.md' }];
  raw = { kortix_version: 3, skills: { 'Research Notes': 'skills/research' }, agents: { worker: { skills: ['Research Notes', 'keep'] }, general: { skills: 'all' } } };
  paths = ['kortix.yaml', 'skills/research/SKILL.md', 'skills/research/references/a.md', 'skills/keep/SKILL.md'];
  writes = [];
});
test('deletes the resolved skill folder and assets, registry and explicit grants in one commit', async () => {
  const res = await remove();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(writes).toHaveLength(1);
  expect(firstWrite().deletes).toEqual(['skills/research/SKILL.md', 'skills/research/references/a.md']);
  const manifest = writtenManifest();
  expect(manifest.skills).toEqual({});
  expect(manifest.agents.worker.skills).toEqual(['keep']);
  expect(manifest.agents.general.skills).toBe('all');
  expect(firstWrite().expectedFileRevision).toMatchObject({ path: 'kortix.yaml', sha: 'abc' });
});
test('unknown identity does not guess a directory', async () => {
  expect((await remove('research')).status).toBe(404);
  expect(writes).toHaveLength(0);
});
test('managed skills cannot be deleted', async () => {
  skills = [{ name: 'kortix-system', path: 'skills/kortix-system/SKILL.md' }];
  expect((await remove('kortix-system')).status).toBe(403);
  expect(writes).toHaveLength(0);
});
test('workspace and capability gates block writes', async () => {
  workspaceDenied = true;
  expect((await remove()).status).toBe(403);
  workspaceDenied = false; denied = true;
  expect((await remove()).status).toBe(403);
  expect(writes).toHaveLength(0);
});
test('rejects traversal in a configured skill path', async () => {
  skills = [{ name: 'Research Notes', path: 'skills/../private/SKILL.md' }];
  expect((await remove()).status).toBe(409);
  expect(writes).toHaveLength(0);
});
test('rejects nested skills and manifest overlap', async () => {
  skills.push({ name: 'nested', path: 'skills/research/nested/SKILL.md' });
  expect((await remove()).status).toBe(409);
  skills.pop(); paths.push('skills/research/kortix.yaml');
  raw.skills = { 'Research Notes': 'skills/research', shared: 'skills/research' };
  expect((await remove()).status).toBe(409);
  expect(writes).toHaveLength(0);
});
test('duplicate display names are ambiguous', async () => {
  skills.push({ name: 'Research Notes', path: 'skills/other/SKILL.md' });
  expect((await remove()).status).toBe(409);
  expect(writes).toHaveLength(0);
});
test('legacy discovered skills do not need a registry entry', async () => {
  raw = { kortix_version: 2, agents: { worker: { skills: ['research'] } } };
  expect((await remove()).status).toBe(200);
  expect(writtenManifest().agents.worker.skills).toEqual([]);
});
test('commit failures return 502 without success', async () => {
  failure = new Error('remote unavailable');
  expect((await remove()).status).toBe(502);
  expect(writes).toHaveLength(0);
});
test('rejects folders containing the manifest or another agent prompt', async () => {
  skills = [{ name: 'Research Notes', path: 'config/skills/SKILL.md' }];
  raw.skills = { 'Research Notes': 'config/skills' };
  raw.agents = { worker: { prompt_file: 'config/skills/agent.md' } };
  expect((await remove()).status).toBe(409);
  expect(writes).toHaveLength(0);
});
test('registry-only entries can be removed without guessing files', async () => {
  paths = ['kortix.yaml'];
  expect((await remove()).status).toBe(200);
  expect(firstWrite().deletes).toEqual([]);
});
test('refuses imported manifests rather than flattening configuration', async () => {
  // Imported manifests are covered by the pure planner test below.
  const { prepareSkillDeletion } = await import('../lib/skill-delete');
  const edit = prepareSkillDeletion('Research Notes', skills, paths.map(path => ({ path })), {
    schemaVersion: 3, raw, path: 'kortix.yaml', format: 'yaml', imports: {} as NonNullable<ParsedManifest['imports']>,
  });
  expect(edit.ok).toBe(false);
});
test('legacy grants use the discovered folder slug, not the frontmatter title', async () => {
  raw = { kortix_version: 2, agents: { worker: { skills: ['research', 'keep'] } } };
  expect((await remove()).status).toBe(200);
  expect(writtenManifest().agents.worker.skills).toEqual(['keep']);
});
test('rejects a shadowed fallback copy that would resurrect the skill', async () => {
  raw = { kortix_version: 2 };
  paths.push('.kortix/opencode/skills/research/SKILL.md');
  expect((await remove()).status).toBe(409);
  expect(writes).toHaveLength(0);
});
test('refuses a registered source subtree without its own skill entrypoint', async () => {
  skills = [{ name: 'Research Notes', path: 'apps/api/SKILL.md' }];
  raw.skills = { 'Research Notes': 'apps/api' };
  paths = ['kortix.yaml', 'apps/api/src/index.ts', 'apps/api/nested/SKILL.md'];
  expect((await remove()).status).toBe(409);
  expect(writes).toHaveLength(0);
});
for (const resource of ['tool', 'opencode', 'pi', 'pi-package'] as const) {
  test(`refuses skill assets shared with a ${resource} module without writing`, async () => {
    if (resource === 'tool') raw.tools = { shared: 'skills/research/tool.ts' };
    else raw.extensions = { shared: resource === 'pi-package'
      ? { pi: { source: './skills/research', extensions: ['*.ts'] } }
      : { [resource]: 'skills/research/extension.ts' } };
    raw.agents = { worker: { tools: ['shared'], extensions: ['shared'] } };
    expect((await remove()).status).toBe(409);
    expect(writes).toHaveLength(0);
  });
}
test('legacy deletion preserves a different skill whose slug matches the deleted display name', async () => {
  skills = [
    { name: 'keep', path: 'skills/research/SKILL.md' },
    { name: 'Other skill', path: 'skills/keep/SKILL.md' },
  ];
  raw = { kortix_version: 2, agents: { worker: { skills: ['research', 'keep'] } } };
  paths.push('skills/keep/SKILL.md');
  const response = await remove('keep');
  expect(response.status).toBe(200);
  expect(writtenManifest().agents.worker.skills).toEqual(['keep']);
  expect(firstWrite().deletes).not.toContain('skills/keep/SKILL.md');
});
for (const file of ['skills/research/agents/worker.md', 'skills/research/agents/other.md', 'skills/research/agent/other.md']) {
  test(`refuses deletion of a legacy skill containing implicit agent prompt ${file}`, async () => {
    raw = { kortix_version: 2, opencode: { config_dir: 'skills/research' }, agents: { worker: {} } };
    paths.push(file);
    expect((await remove()).status).toBe(409);
    expect(writes).toHaveLength(0);
  });
}
test('an explicit agent file outside the skill replaces its unused conventional candidate', async () => {
  raw.agents = { worker: { file: 'agents/worker.md' } };
  raw.opencode = { config_dir: 'skills/research' };
  expect((await remove()).status).toBe(200);
  expect(writes).toHaveLength(1);
});
for (const file of ['command/report.md', 'commands/report.md', 'opencode.json', 'opencode.jsonc']) {
  test(`refuses deletion of legacy native configuration ${file}`, async () => {
    raw = { kortix_version: 2, opencode: { config_dir: 'skills/research' } };
    paths.push(`skills/research/${file}`);
    expect((await remove()).status).toBe(409);
    expect(writes).toHaveLength(0);
  });
}
test('ordinary skill reference markdown does not count as native configuration', async () => {
  raw = { kortix_version: 2, opencode: { config_dir: 'harnesses/opencode' } };
  paths.push('skills/research/commands/report.md');
  expect((await remove()).status).toBe(200);
  expect(firstWrite().deletes).toContain('skills/research/commands/report.md');
});
