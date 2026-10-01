import { describe, expect, test } from 'bun:test';
import { mock } from 'bun:test';
mock.module('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));
import { createMcpApp } from './index';

const project = '11111111-1111-4111-8111-111111111111';
const ctx = {
  authorization: 'Bearer test', origin: 'http://localhost', headers: new Headers(), deadline: Date.now() + 55_000,
  dispatch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/v1/accounts') return Response.json([{ account_id: 'a', name: 'Test' }]);
    if (path === `/v1/projects/${project}/files`) return Response.json([]);
    if (path === '/v1/projects') return Response.json([{ project_id: project, name: 'P' }]);
    if (path.endsWith('/sessions')) return Response.json([]);
    if (path === '/v1/skills') return Response.json({ skills: [{ name: 'guide', description: 'A guide' }] });
    if (path === '/v1/openapi.json') return Response.json({ paths: { '/v1/projects': { get: { summary: 'List projects', responses: {} } } } });
    return new Response('missing', { status: 404 });
  },
};
const app = createMcpApp(ctx.dispatch);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await app.request('http://localhost/', { method: 'POST', headers: { authorization: 'Bearer test' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const payload = await response.json();
  if (payload.error) return payload.error;
  return payload.result;
};
const firstText = async (name: string, args: Record<string, unknown> = {}) => {
  const content = (await call(name, args)).content[0];
  if (content?.type !== 'text') throw new Error('expected text content');
  return content.text;
};

describe('MCP tool families through tools/call', () => {
  test('projects success and validation error', async () => {
    expect(await firstText('list_projects')).toContain('"project_id"');
    expect(await call('start_session', { prompt: 'hello', project_id: 'bad' })).toEqual({ content: [{ type: 'text', text: 'project_id must be a UUID (list_projects shows them)' }], isError: true });
  });
  test('sessions success and validation error', async () => {
    expect(await firstText('list_sessions', { project_id: project })).toContain('"sessions": []');
    expect(await call('send_message', { session_id: 'bad', text: 'hello' })).toEqual({ content: [{ type: 'text', text: 'session_id must be a UUID' }], isError: true });
  });
  test('sandbox success and validation error', async () => {
    expect(await firstText('list_files', { project_id: project })).toContain('No files at the default branch.');
    expect(await call('write_file', { content: 'x', session_id: 'bad', path: 'x', encoding: 'base64' })).toEqual({ content: [{ type: 'text', text: 'content is not valid base64; nothing was written' }], isError: true });
  });
  test('platform success and validation error', async () => {
    expect(await firstText('read_skill')).toContain('guide — A guide');
    expect(await call('call_api', { method: 'DELETE', path: '/v1/oauth/token' })).toEqual({ content: [{ type: 'text', text: 'path must start with /v1/ and not target /v1/oauth or an MCP endpoint' }], isError: true });
  });
  test('unknown tool keeps the JSON-RPC error', async () => {
    expect(await call('unknown')).toEqual({ code: -32602, message: 'Unknown tool: unknown' });
  });
});
