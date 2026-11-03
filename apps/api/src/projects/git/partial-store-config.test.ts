// `loadProjectConfig` (what GET /detail serves) on a cold partial project
// store: the imported manifests and every skill's SKILL.md arrive in a few
// fetches, not one fetch per file.
//
// Why (2026-11-03): a project with 8 imports and 45 skills paid 55 fetches of
// ~0.5 s each, one at a time, and /detail failed with 503 `request_deadline`.
// Every fetch into a store writes one pack (`fetch.unpackLimit=1`), so the pack
// count is the fetch count.
import { afterEach, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadProjectConfig, loadRepoConfigSummary, withKortixSkills } from './config';
import { listRepoFiles } from './files';
import { createPartialStoreFixture, type PartialStoreFixture } from './__tests__/partial-store-fixture';

let fx: PartialStoreFixture | null = null;
afterEach(async () => {
  await fx?.cleanup();
  fx = null;
});

const DOMAINS = ['alpha', 'beta', 'gamma', 'delta'];
const SKILLS_PER_DOMAIN = 5;

function seed(): Record<string, string> {
  const files: Record<string, string> = {
    'kortix.yaml': `imports:\n${DOMAINS.map((domain) => `  - ${domain}/kortix.yaml\n`).join('')}`,
  };
  for (const domain of DOMAINS) {
    const skills = Array.from({ length: SKILLS_PER_DOMAIN }, (_, i) => `${domain}-skill-${i}`);
    files[`${domain}/kortix.yaml`] =
      `agents:\n  ${domain}-agent:\n    connectors: all\nskills:\n${skills.map((name) => `  ${name}: ${domain}/skills/${name}\n`).join('')}`;
    for (const name of skills) {
      files[`${domain}/skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nBody of ${name}.\n`;
    }
  }
  return files;
}

async function packCount(storePath: string): Promise<number> {
  return (await readdir(join(storePath, 'objects', 'pack'))).filter((name) => name.endsWith('.pack')).length;
}

test('a cold store reads 4 imports and 20 skills in at most 4 fetches after the clone', async () => {
  fx = await createPartialStoreFixture(seed());

  const config = await loadProjectConfig(fx.project);

  for (const domain of DOMAINS) {
    expect(config.agents.map((agent) => agent.name)).toContain(`${domain}-agent`);
    for (let i = 0; i < SKILLS_PER_DOMAIN; i++) {
      const name = `${domain}-skill-${i}`;
      expect(config.skills.find((skill) => skill.name === name)?.description).toBe(`The ${name} skill.`);
    }
  }
  // The clone (commits), the trees, the imported manifests, the skills. The
  // root manifest may take one more. Per-file fetches made this 26.
  expect(await packCount(fx.storePath())).toBeLessThanOrEqual(5);
});

test('a summary pinned to a commit reads that commit after the branch moved, and adds up to the live config', async () => {
  fx = await createPartialStoreFixture(seed());
  const before = await fx.push({}, 'pin here');
  await fx.push({ 'alpha/skills/alpha-skill-0/SKILL.md': '---\nname: alpha-skill-0\ndescription: Changed.\n---\n' }, 'change a skill');

  const pinned = await loadRepoConfigSummary(fx.project, await listRepoFiles(fx.project, before), before);
  expect(pinned.skills.find((skill) => skill.name === 'alpha-skill-0')?.description).toBe('The alpha-skill-0 skill.');

  const live = await loadProjectConfig(fx.project);
  expect(live.skills.find((skill) => skill.name === 'alpha-skill-0')?.description).toBe('Changed.');
  expect(withKortixSkills(await loadRepoConfigSummary(fx.project))).toEqual(live);
});
