import { describe, expect, test } from 'bun:test';
// The matcher Next itself compiles `redirects()` sources with. It ships no types.
// @ts-expect-error -- next/dist/compiled/path-to-regexp has no declaration file.
import * as pathToRegexp from 'next/dist/compiled/path-to-regexp';

import { locales } from '@/i18n/catalog.mjs';

import {
  DESKTOP_LEGACY_PATH_SCRIPT,
  desktopShellPath,
  workspaceDesktopRewrites,
  workspacePathOfDesktopLegacy,
  workspaceRedirects,
} from './workspace-redirects';

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

// ── Installed desktop shells (pre-Workspaces nav-rules.js) ────────────────────
// The APP_PATH_PREFIXES of every shell shipped before this release: a server
// redirect to any other path opens in the system browser and empties the window.
const OLD_SHELL_APP_PATHS = ['/projects', '/new', '/settings', '/invites', '/admin', '/setup', '/connectors', '/oauth', '/checkout', '/tunnel', '/capture', '/github', '/cli', '/marketplace', '/maintenance', '/countryerror', '/debug'];
const oldShellLoads = (path: string) =>
  path === '/' || path === '/auth' || path.startsWith('/auth/') || OLD_SHELL_APP_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Electron/38 KortixDesktop/0.1.0';

function headerMatches(condition: { type: string; key: string; value: string }, ua: string): boolean {
  return condition.type === 'header' && new RegExp(`^${condition.value}$`).test(ua);
}

/** Next's redirect pass for a request with `ua`: query conditions as above, header `has`/`missing` on the UA. */
function redirectFor(url: string, ua: string): string | null {
  const { pathname } = new URL(url, 'http://kortix.test');
  for (const rule of rules) {
    if (!match(rule.source, { decode: decodeURIComponent })(pathname)) continue;
    if (rule.has?.some((c) => c.type === 'query')) continue;
    if (rule.has?.some((c) => c.type === 'header' && !headerMatches(c, ua))) continue;
    if (rule.missing?.some((c) => headerMatches(c, ua))) continue;
    const params = (match(rule.source, { decode: decodeURIComponent })(pathname) as { params: object }).params;
    return compile(rule.destination)(params);
  }
  return null;
}

describe('an installed desktop shell keeps every app page in its window', () => {
  test.each(['/projects', '/projects/start', '/projects/p1', '/projects/p1/sessions/s1', '/new'])(
    '%s: no server redirect for the shell; the page is served from /workspaces',
    (path) => {
      expect(redirectFor(path, DESKTOP_UA)).toBeNull();
      const rewrite = workspaceDesktopRewrites().find((r) => match(r.source, { decode: decodeURIComponent })(path));
      expect(rewrite?.has?.every((c) => headerMatches(c, DESKTOP_UA))).toBe(true);
      const params = (match(rewrite!.source, { decode: decodeURIComponent })(path) as { params: object }).params;
      expect(compile(rewrite!.destination)(params)).toBe(workspacePathOfDesktopLegacy(path)!);
    },
  );

  test.each([
    ['/projects/p1/config', '/projects/p1/admin/general'],
    ['/projects/p1/agent', '/projects/p1/customize/agents'],
  ])('an old deep link %s redirects the shell to %s, a path it loads', (path, location) => {
    expect(redirectFor(path, DESKTOP_UA)).toBe(location);
    expect(oldShellLoads(location)).toBe(true);
  });

  test('a browser keeps the 308 to /workspaces', () => {
    expect(redirectFor('/projects/p1', 'Mozilla/5.0 Chrome/140')).toBe('/workspaces/p1');
    expect(redirectFor('/projects/p1/config', 'Mozilla/5.0 Chrome/140')).toBe('/workspaces/p1/admin/general');
  });

  test('the server-side landing paths the middleware and sign-in send the shell are paths it loads', () => {
    for (const landing of ['/workspaces/start', '/workspaces/p1', '/workspaces/p1/sessions/s1', '/settings/billing']) {
      expect(oldShellLoads(desktopShellPath(landing))).toBe(true);
    }
  });

  test('before hydration the shell shows the /workspaces URL of a legacy path', () => {
    for (const [from, to] of [['/projects/p1/sessions/s1?x=1', '/workspaces/p1/sessions/s1?x=1'], ['/new', '/workspaces/new'], ['/projects', '/workspaces']] as const) {
      const [pathname, search = ''] = from.split('?');
      const calls: string[] = [];
      const window = {
        location: { pathname, search: search ? `?${search}` : '', hash: '' },
        history: { state: { k: 1 }, replaceState: (_s: unknown, _t: string, url: string) => calls.push(url) },
      };
      new Function('window', DESKTOP_LEGACY_PATH_SCRIPT)(window);
      expect(calls).toEqual([to]);
    }
  });
});
