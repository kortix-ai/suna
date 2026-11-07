/**
 * The route-param codemod (`scripts/codemods/workspace-route-params.ts`) renamed
 * `:projectId` / `:accountId` to `:workspaceId` in route paths and in the
 * OpenAPI param schemas. A path renamed without its schema key fails only at
 * runtime (zod answers 400 for a missing param), which tsc cannot see. This
 * file reads the real OpenAPI document and fails on every operation whose path
 * template and declared path parameters disagree, and on a source file the
 * codemod would still change.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const { app } = await import('../index');

type Operation = { parameters?: Array<{ in?: string; name?: string }> };

const doc = (app as unknown as {
  getOpenAPI31Document(config: object): { paths: Record<string, Record<string, Operation>> };
}).getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '0' } });

describe('workspace route params', () => {
  test('every OpenAPI path parameter is declared under the name its path uses', () => {
    const mismatches: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      const inPath = new Set([...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!));
      for (const [method, op] of Object.entries(item)) {
        if (!op || typeof op !== 'object' || !('responses' in op)) continue;
        const declared = new Set((op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name!));
        // zod-openapi only lists params the route's `params` schema declares. A
        // route with no schema declares none; then nothing can disagree.
        if (declared.size === 0) continue;
        const missing = [...inPath].filter((name) => !declared.has(name));
        const extra = [...declared].filter((name) => !inPath.has(name));
        if (missing.length || extra.length) {
          mismatches.push(`${method.toUpperCase()} ${path} missing=[${missing}] extra=[${extra}]`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('no OpenAPI path still names projectId or accountId', () => {
    const old = Object.keys(doc.paths).filter((p) => /\{(projectId|accountId)\}/.test(p));
    expect(old).toEqual([]);
  });

  test('the codemod is idempotent on the committed source', () => {
    const repo = join(import.meta.dir, '../../../..');
    const run = Bun.spawnSync(['bun', 'scripts/codemods/workspace-route-params.ts', '--check'], { cwd: repo });
    expect(run.stdout.toString() + run.stderr.toString()).toContain('would change 0 of');
    expect(run.exitCode).toBe(0);
  }, 60_000);
});
