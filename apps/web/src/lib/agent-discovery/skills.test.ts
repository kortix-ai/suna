import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { GET as getIndex } from '@/app/(public)/well-known/agent-skills/index.json/route';
import { GET as getSkill } from '@/app/(public)/well-known/agent-skills/[name]/SKILL.md/route';
import { AGENT_SKILLS, buildSkillsIndex, readSkillBody } from './skills';

describe('agent skills index', () => {
  test('publishes the three outward-facing skills', () => {
    expect(AGENT_SKILLS.map((skill) => skill.name)).toEqual([
      'kortix-api',
      'kortix-sdk',
      'kortix-agent-content',
    ]);
  });

  test('every entry resolves to a readable SKILL.md', () => {
    for (const skill of AGENT_SKILLS) {
      expect(readSkillBody(skill.name)).toBeTruthy();
    }
  });

  test('the digest matches the bytes the sibling route serves', async () => {
    for (const entry of buildSkillsIndex().skills) {
      const response = await getSkill(new Request('https://kortix.com'), {
        params: Promise.resolve({ name: entry.name }),
      });
      const served = await response.text();
      expect(createHash('sha256').update(served, 'utf8').digest('hex')).toBe(
        entry.sha256,
      );
    }
  });

  test('every url is absolute and points at this origin', () => {
    for (const entry of buildSkillsIndex().skills) {
      expect(entry.url).toBe(
        `https://kortix.com/.well-known/agent-skills/${entry.name}/SKILL.md`,
      );
    }
  });

  test('declares the discovery RFC schema and the skill type', () => {
    const index = buildSkillsIndex();
    expect(index.$schema).toBe('https://agentskills.io/schemas/v0.2.0/index.json');
    for (const entry of index.skills) {
      expect(entry.type).toBe('skill');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  test('kortix-sdk no longer claims the SDK handles token refresh', () => {
    // packages/sdk/src/core/http/config.ts calls getToken per request and
    // caches nothing; the app owns refresh, not the SDK.
    const body = readSkillBody('kortix-sdk');
    expect(body).not.toContain('handles token refresh');
    expect(body).toContain('caches nothing');
  });

  test('kortix-api documents the self-service bearer token credentials', () => {
    const body = readSkillBody('kortix-api');
    expect(body).toContain('kortix_pat_');
    expect(body).toContain('kortix_sa_');
  });

  test('an unknown skill name is a 404, not a path traversal', async () => {
    const response = await getSkill(new Request('https://kortix.com'), {
      params: Promise.resolve({ name: '../../../../etc/passwd' }),
    });
    expect(response.status).toBe(404);
  });

  test('the index route serves application/json', async () => {
    const response = getIndex();
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(buildSkillsIndex());
  });

  test('a skill route serves markdown', async () => {
    const response = await getSkill(new Request('https://kortix.com'), {
      params: Promise.resolve({ name: 'kortix-api' }),
    });
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });
});
