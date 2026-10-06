import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { createProjectSkill } from './skills';

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
