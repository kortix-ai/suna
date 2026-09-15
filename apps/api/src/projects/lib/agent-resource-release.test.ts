import { expect, mock, test } from 'bun:test';
let content: string | null = null;
const calls: unknown[][] = [];
mock.module('../git', () => ({
  readManifestFromRepo: async (...args: unknown[]) => {
    calls.push(args);
    return content ? { path: 'kortix.yaml', content } : null;
  },
}));
const { agentResourceSourceSha, resolveOpenCodeResourceSourceSha } = await import('./agent-resource-release');
const project = { projectId: 'project', repoUrl: 'https://git.test/repo', defaultBranch: 'main', manifestPath: 'kortix.yaml' };
const sha = 'a'.repeat(40);

test.each([undefined, null, {}, { agent_resources_sha: null }])('absent resource identity remains absent: %j', value => {
  expect(agentResourceSourceSha(value)).toBeUndefined();
});
test.each(['main', '', 'A'.repeat(40), 3, {}])('invalid source identity fails closed: %j', value => {
  expect(() => agentResourceSourceSha({ agent_resources_sha: value })).toThrow(/identity/);
});
test('resource identity pins only the selected OpenCode agent with environment files', async () => {
  content = 'kortix_version: 2\nagents:\n  selected:\n    resources:\n      environment:\n        - source: x\n          target: /workspace/x\n          mode: seed\n  other: {}\n';
  expect(await resolveOpenCodeResourceSourceSha(project, sha, 'selected')).toBe(sha);
  expect(calls.at(-1)?.[2]).toBe(sha);
  expect(await resolveOpenCodeResourceSourceSha(project, sha, 'other')).toBeUndefined();
  expect(await resolveOpenCodeResourceSourceSha(project, sha, 'missing')).toBeUndefined();
  content = content.replace('version: 2', 'version: 3');
  expect(await resolveOpenCodeResourceSourceSha(project, sha, 'selected')).toBeUndefined();
  content = null;
  expect(await resolveOpenCodeResourceSourceSha(project, sha, 'selected')).toBeUndefined();
});
