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

/** The lenientBody request schema: the object branch of the anyOf. */
function bodyShape(method: string, path: string): any {
  const schema = doc.paths[path]?.[method]?.requestBody?.content?.['application/json']?.schema;
  return schema?.properties ? schema : schema?.anyOf?.find((s: any) => s.properties);
}

/** Property names of a JSON request body, first `anyOf` branch included (lenientBody). */
function bodyProps(method: string, path: string): string[] {
  return Object.keys(bodyShape(method, path)?.properties ?? {});
}

/** One property schema of a JSON request body. */
function bodyProp(method: string, path: string, field: string): any {
  return bodyShape(method, path)?.properties?.[field];
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

  // A comma-separated literal pasted as ONE z.enum value publishes a bogus
  // one-value enum: a generated SDK can only send it and every real value
  // fails client-side validation. Pin the real value sets.
  test.each([
    ['post', '/v1/projects/{projectId}/access/invite', 'role', ['manager', 'member']],
    ['post', '/v1/projects/{projectId}/git/collaborators', 'permission', ['read', 'write']],
  ] as const)('%s %s publishes %s with its real enum values', (method, path, field, values) => {
    expect(bodyProp(method, path, field)?.enum).toEqual(values);
  });

  // And pin the class itself: no request body in the whole document may
  // publish a comma-joined literal as an enum value.
  test('no request body publishes a merged comma-joined literal as an enum', () => {
    const bad: string[] = [];
    const visit = (schema: any, at: string) => {
      if (!schema || typeof schema !== 'object') return;
      if (Array.isArray(schema.enum))
        for (const v of schema.enum)
          if (typeof v === 'string' && /^[a-z0-9_]+(,[a-z0-9_]+)+$/.test(v)) bad.push(`${at}: ${v}`);
      for (const v of Object.values(schema)) if (v && typeof v === 'object') visit(v, at);
    };
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(item))
        visit((op as any).requestBody?.content, `${method} ${path}`);
    expect(bad).toEqual([]);
  });
});
