import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { createProjectSkill, getBuiltinSkill } from './skills';

let nextResponse: () => Response = () => new Response('{}', { status: 200 });

beforeEach(() => {
  globalThis.fetch = mock(async () => nextResponse()) as unknown as typeof fetch;
});

const opts = { backendUrl: 'http://backend.test/v1', accessToken: 'tok' };

describe('createProjectSkill', () => {
  test('POSTs the skill name and description to the project skills route', async () => {
    configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });
    nextResponse = () =>
      new Response(
        JSON.stringify({ ok: true, slug: 'release-notes', path: 'skills/release-notes/SKILL.md' }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );

    const created = await createProjectSkill('proj-1', {
      name: 'Release Notes',
      description: 'Draft the weekly release notes',
    });

    expect(created.slug).toBe('release-notes');
    expect(created.path).toBe('skills/release-notes/SKILL.md');

    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(call[0]).toBe('http://backend.test/v1/projects/proj-1/skills');
    expect(call[1]?.method).toBe('POST');
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      name: 'Release Notes',
      description: 'Draft the weekly release notes',
    });
    const headers = new Headers(call[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok');
  });

  test('surfaces the API error message instead of toasting it globally', async () => {
    configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });
    nextResponse = () =>
      new Response(JSON.stringify({ error: 'A skill named "release-notes" already exists' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });

    let error: Error | null = null;
    try {
      await createProjectSkill('proj-1', { name: 'Release Notes' });
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain('already exists');
  });
});

describe('removeProjectSkill', () => {
  test('removes an explicitly confirmed folder through the project API', async () => {
    const { removeProjectSkill } = await import('./skills');
    nextResponse = () => new Response(JSON.stringify({ ok: true, commitSha: 'abc', removed: ['skills/pdf/SKILL.md'] }), { headers: { 'content-type': 'application/json' } });
    const removed = await removeProjectSkill('proj-1', { folder: 'skills/pdf', confirm: true });
    expect(removed.removed).toEqual(['skills/pdf/SKILL.md']);
    expect(globalThis.fetch).toHaveBeenCalledWith('http://backend.test/v1/projects/proj-1/skills/remove', expect.objectContaining({ method: 'POST', body: JSON.stringify({ folder: 'skills/pdf', confirm: true }) }));
  });
});

describe('getBuiltinSkill', () => {
  test('GETs one Kortix built-in skill by name and returns its SKILL.md body', async () => {
    configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });
    nextResponse = () =>
      new Response(
        JSON.stringify({
          name: 'kortix-memory',
          description: 'How to read and write project memory.',
          body: '# Memory\n\nRead memory/ first.',
          featureFlag: null,
          references: [{ path: 'references/rubric.md', bytes: 120 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const skill = await getBuiltinSkill('kortix-memory');

    expect(skill).toEqual({
      name: 'kortix-memory',
      description: 'How to read and write project memory.',
      body: '# Memory\n\nRead memory/ first.',
      featureFlag: null,
      references: [{ path: 'references/rubric.md', bytes: 120 }],
    });
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('http://backend.test/v1/skills/kortix-memory');
    expect(call[1]?.method ?? 'GET').toBe('GET');
    expect(new Headers(call[1]?.headers).get('authorization')).toBe('Bearer tok');
  });

  test('encodes the name into the path', async () => {
    configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });
    nextResponse = () =>
      new Response(JSON.stringify({ name: 'a b', description: '', body: '', featureFlag: null, references: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await getBuiltinSkill('a b');
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('http://backend.test/v1/skills/a%20b');
  });

  test('full: true asks for every reference file inline', async () => {
    configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });
    nextResponse = () =>
      new Response(
        JSON.stringify({
          name: 'kortix-cli',
          description: 'Drive Kortix from the terminal.',
          body: '---\nname: kortix-cli\n---\n# CLI',
          featureFlag: null,
          references: [{ path: 'references/auth.md', bytes: 9, content: '# Auth\nhi' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const skill = await getBuiltinSkill('kortix-cli', { full: true });
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('http://backend.test/v1/skills/kortix-cli?full=1');
    expect(skill.references).toEqual([{ path: 'references/auth.md', bytes: 9, content: '# Auth\nhi' }]);
  });
});
