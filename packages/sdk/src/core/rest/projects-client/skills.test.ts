import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import { createProjectSkill, deleteProjectSkill } from './skills';

let nextResponse: () => Response = () => new Response('{}', { status: 200 });

beforeEach(() => {
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });
  globalThis.fetch = mock(async () => nextResponse()) as unknown as typeof fetch;
});

const opts = { showErrors: false };

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

describe('deleteProjectSkill', () => {
  test('DELETEs the exact catalog name, URL-encoded, with auth', async () => {
    nextResponse = () => new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
    expect(await deleteProjectSkill('proj-1', 'Release Notes / QA', opts)).toEqual({ ok: true });
    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://backend.test/v1/projects/proj-1/skills/Release%20Notes%20%2F%20QA');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
  });

  test('project facade binds the project id for deletion', async () => {
    nextResponse = () => new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
    const client = createKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'tok' });
    expect(await client.project('proj-1').skills.delete('Release Notes')).toEqual({ ok: true });
    const [url] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [string];
    expect(url).toBe('http://backend.test/v1/projects/proj-1/skills/Release%20Notes');
  });

  test('preserves server rejection messages', async () => {
    nextResponse = () => new Response(JSON.stringify({ error: 'Managed skills cannot be deleted' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    });
    await expect(deleteProjectSkill('proj-1', 'kortix-ui', opts)).rejects.toThrow('Managed skills cannot be deleted');
  });
});
