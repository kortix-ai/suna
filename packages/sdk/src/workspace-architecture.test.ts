import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SDK_ROOT = import.meta.dir;
const WORKSPACES_CLIENT = join(SDK_ROOT, 'core/rest/workspaces-client');
const PROJECTS_CLIENT = join(SDK_ROOT, 'core/rest/projects-client');
const PLATFORM_CLIENT = join(SDK_ROOT, 'core/rest/platform-client');
const REACT_ROOT = join(SDK_ROOT, 'react');

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('Workspace is the canonical SDK implementation', () => {
  test('canonical Workspace REST modules never import the legacy Project client', () => {
    const violations = sourceFiles(WORKSPACES_CLIENT).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const importsLegacyClient =
        /(?:from\s+|import\()(['"])[^'"\n]*projects-client(?:\/[^'"\n]*)?\1/.test(source);
      return importsLegacyClient ? [relative(SDK_ROOT, path)] : [];
    });

    expect(violations).toEqual([]);
  });

  test('the legacy Project client is isolated behind its published boundary', () => {
    expect(statSync(PROJECTS_CLIENT).isDirectory()).toBe(true);
    const barrel = readFileSync(join(PROJECTS_CLIENT, 'index.ts'), 'utf8');
    expect(barrel).toContain("export * from './implementation'");
    expect(barrel).not.toContain('workspaces-client');
  });

  test('canonical Workspace facade blocks depend only on Workspace operations', () => {
    const source = readFileSync(join(SDK_ROOT, 'core/client/kortix.ts'), 'utf8');
    expect(source).toContain("import * as W from '../rest/workspaces-client'");
    expect(source).toContain("import * as P from '../rest/projects-client'");

    const workspaceCollection = source.slice(
      source.indexOf('  const workspaces = {'),
      source.indexOf('  /** GitHub App installation', source.indexOf('  const workspaces = {')),
    );
    const workspaceHandle = source.slice(
      source.indexOf('  function workspace('),
      source.indexOf('  /** Id-bound handle for a single session:', source.indexOf('  function workspace(')),
    );
    const workspaceSession = source.slice(
      source.indexOf('  function workspaceSession('),
      source.indexOf('\n  return {', source.indexOf('  function workspaceSession(')),
    );

    for (const block of [workspaceCollection, workspaceHandle, workspaceSession]) {
      expect(block).not.toContain('P.');
      expect(block).not.toMatch(/\bProject\b|\bproject\b/);
    }
  });

  test('canonical React modules use Workspace REST clients and query keys', () => {
    const violations = sourceFiles(REACT_ROOT).flatMap((path) => {
      const relativePath = relative(SDK_ROOT, path);
      const source = readFileSync(path, 'utf8');
      const reasons: string[] = [];
      if (/core\/rest\/projects-client/.test(source)) reasons.push('legacy REST client');
      if (
        relativePath !== 'react/query-keys.ts' &&
        /\bqk\.(?:project|projects)\b/.test(source)
      ) {
        reasons.push('legacy query key');
      }
      return reasons.map((reason) => `${relativePath}: ${reason}`);
    });

    expect(violations).toEqual([]);
  });

  test('canonical transports never send requests to the legacy Project namespace', () => {
    const violations = [WORKSPACES_CLIENT, PLATFORM_CLIENT, REACT_ROOT]
      .flatMap(sourceFiles)
      .flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        const code = source
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        return /['"`]\/projects(?:\/|['"`])/.test(code) ? [relative(SDK_ROOT, path)] : [];
      });

    expect(violations).toEqual([]);
  });
});
