import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { importProjectSkill } from './project-skills';

let calls: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      body: options.body ? (JSON.parse(String(options.body)) as Record<string, unknown>) : {},
    });
    return new Response(
      JSON.stringify({
        skills: [
          {
            slug: 'triage',
            name: 'triage',
            description: 'Triage',
            files: [
              { path: '.kortix/opencode/skills/triage/SKILL.md', size: 96 },
              {
                path: '.kortix/opencode/skills/triage/assets/icon.png',
                size: 128,
              },
            ],
          },
        ],
        paths: ['.kortix/opencode/skills/triage/SKILL.md'],
        branch: 'kortix/skills/import/triage-20260803120000-deadbeef',
        target: {
          type: 'project_repo',
          repo_url: 'https://github.com/acme/project-1.git',
          repo_name: 'project-1',
          managed: true,
          base_branch: 'main',
          branch: 'kortix/skills/import/triage-20260803120000-deadbeef',
          path_prefix: '.kortix/opencode/skills',
        },
        commit_sha: 'a'.repeat(40),
        change_request: { cr_id: 'CR1', number: 1 },
      }),
      {
        status: 201,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as unknown as typeof fetch;
});

configureKortix({
  backendUrl: 'http://test.local',
  getToken: async () => 'tok',
});

describe('importProjectSkill', () => {
  test('posts project skill archives to the project import route', async () => {
    const result = await importProjectSkill('project-1', {
      fileName: 'triage.skill',
      dataBase64: 'UEsDBA==',
    });

    expect(calls).toEqual([
      {
        url: 'http://test.local/projects/project-1/skills/import',
        body: { fileName: 'triage.skill', dataBase64: 'UEsDBA==' },
      },
    ]);
    expect(result.change_request.number).toBe(1);
    expect(result.paths).toEqual(['.kortix/opencode/skills/triage/SKILL.md']);
    expect(result.skills[0]?.files).toEqual([
      { path: '.kortix/opencode/skills/triage/SKILL.md', size: 96 },
      { path: '.kortix/opencode/skills/triage/assets/icon.png', size: 128 },
    ]);
    expect(result.target).toMatchObject({
      type: 'project_repo',
      repo_url: 'https://github.com/acme/project-1.git',
      managed: true,
      path_prefix: '.kortix/opencode/skills',
    });
  });
});
