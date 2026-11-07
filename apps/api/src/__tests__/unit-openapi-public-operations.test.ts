import { describe, expect, test } from 'bun:test';
import { app } from '../index';
import { PUBLIC_OPERATIONS } from '../shared/openapi-public-operations';
import { markPublicOperations } from '../openapi';

type Document = {
  paths: Record<string, Record<string, { security?: Record<string, string[]>[] }>>;
};

async function served(): Promise<Document> {
  const response = await app.request('/v1/openapi.json');
  expect(response.status).toBe(200);
  return response.json();
}

describe('published OpenAPI public operations', () => {
  test('every operation is either guarded or explicitly public, and the public set is the listed one', async () => {
    const document = await served();
    const unmarked: string[] = [];
    const publicOps = new Set<string>();
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const key = `${method} ${path}`;
        if (!operation.security) unmarked.push(key);
        else if (operation.security.length === 0) publicOps.add(key);
      }
    }
    expect(unmarked, 'operations with neither `auth` nor a PUBLIC_OPERATIONS entry').toEqual([]);
    expect([...publicOps].sort()).toEqual([...PUBLIC_OPERATIONS].sort());
  });

  test('the public set carries the documented anonymous GET routes', async () => {
    const document = await served();
    expect(document.paths['/v1/auth/client-config']?.get?.security).toEqual([]);
    expect(document.paths['/v1/health']?.get?.security).toEqual([]);
    expect(document.paths['/v1/projects']?.get?.security).toEqual([{ bearerAuth: [] }]);
  });

  test('host-key and cron-key guarded operations are never published as anonymous', async () => {
    const document = await served();
    for (const [path, method] of [
      ['/v1/billing/cron/yearly-rotation', 'post'],
      ['/v1/billing/cron/free-tier-rotation', 'post'],
      ['/v1/billing/cron/trial-expiry', 'post'],
      ['/v1/setup/bootstrap-owner', 'post'],
    ] as const) {
      expect(document.paths[path]?.[method]?.security, `${method} ${path}`).toEqual([{ bearerAuth: [] }]);
    }
  });
});

describe('markPublicOperations', () => {
  const doc: { paths: Record<string, Record<string, { summary?: string; security?: Record<string, string[]>[] }>> } = {
    paths: {
      '/open': { get: { summary: 'a' }, post: { security: [{ bearerAuth: [] }] } },
      '/other': { get: { summary: 'b' } },
    },
  };

  test('marks only listed operations without security, never mutating the input', () => {
    const out = markPublicOperations(doc, new Set(['get /open', 'post /open']));
    expect(out.paths['/open'].get).toEqual({ summary: 'a', security: [] });
    expect(out.paths['/open'].post).toEqual({ security: [{ bearerAuth: [] }] });
    expect(out.paths['/other'].get).toEqual({ summary: 'b' });
    expect(doc.paths['/open'].get).toEqual({ summary: 'a' });
  });
});
