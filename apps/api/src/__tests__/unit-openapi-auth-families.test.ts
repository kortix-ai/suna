import { describe, expect, test } from 'bun:test';
import { app } from '../index';

describe('published OpenAPI authentication', () => {
  test.each([
    ['/scim/v2/', 17],
    ['/v1/git/', 5],
  ])('%s operations require a defined bearer scheme', async (prefix, minimum) => {
    const response = await app.request('/v1/openapi.json');
    expect(response.status).toBe(200);
    const document: {
      paths: Record<string, Record<string, { security?: Record<string, string[]>[] }>>;
      components: { securitySchemes: Record<string, { type: string; scheme: string }> };
    } = await response.json();
    const operations = Object.entries(document.paths)
      .filter(([path]) => path.startsWith(prefix))
      .flatMap(([path, item]) => Object.entries(item).map(([method, operation]) => ({ path, method, operation })));
    expect(operations.length).toBeGreaterThanOrEqual(minimum);
    for (const { path, method, operation } of operations) {
      expect(operation.security, `${method} ${path}`).toEqual([{ bearerAuth: [] }]);
    }
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  test('the docs page uses the published spec', async () => {
    const response = await app.request('/v1/docs');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('/v1/openapi.json');
  });
});
