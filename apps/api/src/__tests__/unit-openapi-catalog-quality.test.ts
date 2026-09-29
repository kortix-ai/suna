/**
 * The MCP tools `search_api` / `describe_api` read /v1/openapi.json. An LLM
 * finds a route by the words in its summary and fills its body from the
 * request schema. These tests pin both: no route may fall back to a summary
 * that is only "METHOD /path", and the routes an agent uses most must publish
 * the body fields their handler reads.
 */
import { describe, expect, test } from 'bun:test';
import { app } from '../index';

type Op = { summary?: string; requestBody?: { content?: Record<string, { schema?: any }> } };
const doc: { paths: Record<string, Record<string, Op>> } = await (
  await app.request('http://localhost/v1/openapi.json')
).json();

/** Property names of a JSON request body, first `anyOf` branch included (lenientBody). */
function bodyProps(method: string, path: string): string[] {
  const schema = doc.paths[path]?.[method]?.requestBody?.content?.['application/json']?.schema;
  const first = schema?.properties ? schema : schema?.anyOf?.find((s: any) => s.properties);
  return Object.keys(first?.properties ?? {});
}

describe('OpenAPI catalog quality (MCP search_api / describe_api)', () => {
  test('no operation summary is only "METHOD /path"', () => {
    const bare: string[] = [];
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(item))
        if (/^(GET|POST|PUT|PATCH|DELETE) [/{]/.test(op.summary ?? 'GET /')) bare.push(`${method} ${path}`);
    expect(bare).toEqual([]);
  });

  test.each([
    ['post', '/v1/projects/{projectId}/secrets', ['name', 'value']],
    ['post', '/v1/projects/{projectId}/triggers', ['name', 'type', 'prompt_template', 'cron']],
    ['post', '/v1/projects/{projectId}/change-requests', ['title', 'head_ref']],
    ['post', '/v1/projects/{projectId}/change-requests/{crId}/merge', ['message']],
    ['patch', '/v1/projects/{projectId}/sessions/{sessionId}', ['name']],
    ['post', '/v1/projects/{projectId}/sessions/{sessionId}/prompts', ['client_message_id', 'message_id', 'parts']],
    ['post', '/v1/projects/provision', ['name']],
    ['post', '/v1/projects/{projectId}/access/invite', ['email', 'role']],
    ['post', '/v1/projects/{projectId}/approvals/{executionId}', ['decision', 'note']],
  ] as const)('%s %s documents its body fields', (method, path, fields) => {
    const props = bodyProps(method, path);
    for (const f of fields) expect(props).toContain(f);
  });
});
