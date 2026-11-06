import { describe, expect, test } from 'bun:test';
// The matcher Next itself compiles `redirects()` sources with. It ships no types.
// @ts-expect-error -- next/dist/compiled/path-to-regexp has no declaration file.
import * as pathToRegexp from 'next/dist/compiled/path-to-regexp';

import { locales } from '@/i18n/catalog.mjs';

import { workspaceRedirects } from './workspace-redirects';

const { compile, match } = pathToRegexp as {
  match: (source: string, options: { decode: (value: string) => string }) => (path: string) => false | { params: object };
  compile: (path: string) => (params: object) => string;
};
const rules = workspaceRedirects(locales);

/** Where Next sends `url`: the first rule that matches, its params filled, the query kept. */
function redirectOf(url: string): { location: string; status: 308 | 307 } | null {
  const { pathname, searchParams } = new URL(url, 'http://kortix.test');
  for (const rule of rules) {
    const hit = match(rule.source, { decode: decodeURIComponent })(pathname);
    if (!hit) continue;
    const params: Record<string, string | string[]> = { ...(hit.params as Record<string, string | string[]>) };
    if (rule.has) {
      const ok = rule.has.every((condition) => {
        const value = searchParams.get(condition.key);
        const groups = value === null ? null : new RegExp(`^${condition.value}$`).exec(value)?.groups;
        if (!groups) return false;
        Object.assign(params, groups);
        return true;
      });
      if (!ok) continue;
    }
    const [destinationPath, destinationQuery] = rule.destination.split('?');
    const target = new URL(compile(destinationPath!)(params), 'http://kortix.test');
    if (destinationQuery) {
      for (const [key, value] of new URLSearchParams(destinationQuery)) {
        target.searchParams.set(key, value.replace(/^:(\w+)$/, (_, name: string) => String(params[name])));
      }
    }
    for (const [key, value] of searchParams) if (!target.searchParams.has(key)) target.searchParams.append(key, value);
    return { location: `${target.pathname}${target.search}`, status: rule.permanent ? 308 : 307 };
  }
  return null;
}

describe('the /projects → /workspaces redirects', () => {
  test.each([
    ['/projects', '/workspaces'],
    ['/projects/start', '/workspaces/start'],
    ['/projects/p1', '/workspaces/p1'],
    ['/projects/p1/admin/members?x=1', '/workspaces/p1/admin/members?x=1'],
    ['/projects/p1/sessions/s1?notification=n1', '/workspaces/p1/sessions/s1?notification=n1'],
    ['/projects/p1?accountId=a1&accountTab=members', '/workspaces/p1?accountId=a1&accountTab=members'],
    ['/new', '/workspaces/new'],
    ['/new?source=github-import&account=a1', '/workspaces/new?source=github-import&account=a1'],
    ['/admin/projects', '/admin/workspaces'],
    ['/admin/projects/p1', '/admin/workspaces/p1'],
    ['/de/projects/p1', '/de/workspaces/p1'],
    ['/en/projects', '/en/workspaces'],
    ['/fr/new', '/fr/workspaces/new'],
  ])('%s → 308 %s', (from, to) => {
    expect(redirectOf(from)).toEqual({ location: to, status: 308 });
  });

  test('a renamed tab under the old prefix lands on its final page in one hop', () => {
    expect(redirectOf('/projects/p1/config')).toEqual({ location: '/workspaces/p1/admin/general', status: 307 });
    expect(redirectOf('/projects/p1/agent/kortix')).toEqual({ location: '/workspaces/p1/customize/agents/kortix', status: 307 });
    expect(redirectOf('/projects/p1/backends/app1')).toEqual({ location: '/workspaces/p1/apps?app=app1', status: 307 });
    expect(redirectOf('/projects/p1/customize/settings?section=models')).toEqual({
      location: '/workspaces/p1/admin/models?section=models',
      status: 307,
    });
  });

  test('the renamed tabs keep working under /workspaces', () => {
    expect(redirectOf('/workspaces/p1/config')).toEqual({ location: '/workspaces/p1/admin/general', status: 307 });
  });

  test('a canonical /workspaces page and a look-alike path are not redirected', () => {
    for (const path of ['/workspaces', '/workspaces/p1', '/workspaces/new', '/projectsx', '/newsroom', '/admin/workspaces']) {
      expect(redirectOf(path)).toBeNull();
    }
  });
});
