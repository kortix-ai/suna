/**
 * The redirects of the `/projects` → `/workspaces` move (2026-11-06,
 * Project → Workspace), for `next.config.ts` `redirects()`. Next applies the
 * first rule that matches, before the middleware runs, and keeps the query.
 *
 * Shipped desktop and mobile builds, emailed and Slack links and bookmarks
 * still open `/projects/…`, `/new` and `/admin/projects/…`: each lands on the
 * same path under `/workspaces` with a 308, also behind a locale prefix
 * (`/de/projects/<id>` → `/de/workspaces/<id>`). Mapping test:
 * `workspace-redirects.test.ts`.
 */
type Condition = { type: 'query' | 'header'; key: string; value: string };

export interface Redirect {
  source: string;
  destination: string;
  permanent: boolean;
  has?: Condition[];
  missing?: Condition[];
}

export interface Rewrite {
  source: string;
  destination: string;
  has?: Condition[];
}

/**
 * The installed desktop shells (Electron, every build before the Workspaces
 * release) load only their own list of app paths in the window: `/projects`
 * and `/new`, never `/workspaces`. A server redirect to `/workspaces` fires the
 * shell's `will-redirect` gate, which opens the URL in the system browser and
 * leaves the window empty. Every shell sends the same UA token, so the web
 * cannot tell an old shell from a new one: the desktop shell keeps the old
 * paths, served in place.
 *
 *   - no `/projects` → `/workspaces` 308 for the shell (`missing` the UA);
 *   - an old `/projects/:id/<tab>` link redirects to its new page under
 *     `/projects` (an app path in every shell);
 *   - {@link workspaceDesktopRewrites} serves `/projects/…` and `/new` from
 *     the `/workspaces` pages;
 *   - `DesktopLegacyPathSync` (client) then shows the `/workspaces` URL with
 *     `history.replaceState`, which no shell gates.
 *
 * Client navigations (Link, router.push) never reach the gate. Drop this once
 * every shell in use ships `/workspaces` in its list.
 */
export const DESKTOP_SHELL_UA = 'KortixDesktop';
const DESKTOP: Condition = { type: 'header', key: 'user-agent', value: `.*${DESKTOP_SHELL_UA}.*` };

/** True for a request from the desktop shell. */
export function isDesktopShell(userAgent: string | null | undefined): boolean {
  return Boolean(userAgent?.includes(DESKTOP_SHELL_UA));
}

/** The path an installed desktop shell may load for `path`: `/workspaces…` → `/projects…`. Other paths are unchanged. */
export function desktopShellPath(path: string): string {
  return path.replace(/^\/workspaces(?=$|[/?#])/, '/projects');
}

/** The `/workspaces` path of a legacy desktop URL (`/projects…`, `/new`), or null when `path` is not one. */
export function workspacePathOfDesktopLegacy(path: string): string | null {
  if (/^\/projects(?=$|[/?#])/.test(path)) return path.replace(/^\/projects/, '/workspaces');
  if (/^\/new(?=$|[?#])/.test(path)) return path.replace(/^\/new/, '/workspaces/new');
  return null;
}

/** `rewrites().beforeFiles` for the desktop shell: its legacy paths served from the `/workspaces` pages. */
export function workspaceDesktopRewrites(): Rewrite[] {
  return [
    { source: '/projects', destination: '/workspaces', has: [DESKTOP] },
    { source: '/projects/:path*', destination: '/workspaces/:path*', has: [DESKTOP] },
    { source: '/new', destination: '/workspaces/new', has: [DESKTOP] },
  ];
}

/**
 * For the desktop shell: each rule whose source is a legacy app path and whose
 * destination is a `/workspaces` page gets a twin that answers the shell with
 * the same page under `/projects`; the original rule skips the shell. A twin
 * that would redirect a path to itself is dropped: the rewrite serves it.
 */
function withDesktopShell(rules: Redirect[]): Redirect[] {
  return rules.flatMap((rule) => {
    const legacySource = /^\/(projects|new)(?=$|\/)/.test(rule.source);
    if (!legacySource || !/^\/workspaces(?=$|\/)/.test(rule.destination)) return [rule];
    const destination = desktopShellPath(rule.destination);
    const twin: Redirect[] = destination === rule.source || rule.source === '/new'
      ? []
      : [{ ...rule, destination, has: [...(rule.has ?? []), DESKTOP] }];
    return [...twin, { ...rule, missing: [...(rule.missing ?? []), DESKTOP] }];
  });
}

export function workspaceRedirects(locales: readonly string[]): Redirect[] {
  return withDesktopShell(workspaceRedirectTable(locales));
}

function workspaceRedirectTable(locales: readonly string[]): Redirect[] {
  const locale = `/:locale(${locales.join('|')})`;
  return [
    // Every workspace page moved from /projects to /workspaces (2026-11-06,
    // Project → Workspace). The rules below that rename a page under a
    // workspace run for both prefixes, so an old /projects/<id>/<old tab>
    // link lands on its final /workspaces page in one hop. The catch-alls
    // after them send every other /projects URL (bookmarks, emailed and
    // Slack links, shipped desktop and mobile builds) to the same path under
    // /workspaces with a 308, the query kept.
    ...(['/workspaces', '/projects'] as const).flatMap((prefix): Redirect[] => [
      // Capability tabs moved under /customize/ (2026-09-03). The old
      // top-level segments were shared in Slack, saved as bookmarks and baked
      // into agent transcripts, so every one keeps resolving. `agent` became
      // `agents`, `config` became `settings`; the rest kept their names.
      // `review` is NOT in this list: `/workspaces/:id/review` is Review's own
      // page (2026-11-04), and `customize/review/page.tsx` redirects to it.
      {
        source: `${prefix}/:id/agent/:path*`,
        destination: '/workspaces/:id/customize/agents/:path*',
        permanent: false,
      },
      {
        source: `${prefix}/:id/agent`,
        destination: '/workspaces/:id/customize/agents',
        permanent: false,
      },
      // The project-wide libraries and settings have one home, Project admin
      // (`/workspaces/:id/admin/<section>`, 2026-10-27). Customize keeps Agents
      // and Review. Every older address lands there in one hop: the
      // top-level tabs, their `/customize/` successors, and the Project admin
      // `?section=` form.
      {
        source: `${prefix}/:id/config`,
        destination: '/workspaces/:id/admin/general',
        permanent: false,
      },
      {
        source: `${prefix}/:id/:tab(skills|connectors|triggers|models|secrets)`,
        destination: '/workspaces/:id/admin/:tab',
        permanent: false,
      },
      {
        source: `${prefix}/:id/customize/:tab(skills|tools|extensions|drives|triggers|models|secrets)`,
        destination: '/workspaces/:id/admin/:tab',
        permanent: false,
      },
      {
        source: `${prefix}/:id/customize/connectors/:path*`,
        destination: '/workspaces/:id/admin/connectors/:path*',
        permanent: false,
      },
      {
        source: `${prefix}/:id/customize/reminders`,
        destination: '/workspaces/:id/admin/triggers',
        permanent: false,
      },
      {
        source: `${prefix}/:id/customize/repo`,
        destination: '/workspaces/:id/admin/repo',
        permanent: false,
      },
      {
        source: `${prefix}/:id/customize/settings`,
        has: [{ type: 'query', key: 'section', value: '(?<section>[a-z-]+)' }],
        destination: '/workspaces/:id/admin/:section',
        permanent: false,
      },
      {
        source: `${prefix}/:id/customize/settings`,
        destination: '/workspaces/:id/admin/general',
        permanent: false,
      },
      {
        source: `${prefix}/:id/:prefix(customize|admin)/apps`,
        destination: '/workspaces/:id/apps',
        permanent: false,
      },
      // Backends became Apps (2026-10-09), and a migrated
      // App keeps its backend's id. The retired Backends pages and the
      // Customize tab land on the Apps page, the one with an id opening that App.
      ...[`${prefix}/:id/backends`, `${prefix}/:id/customize/backends`].flatMap((retired) => [
        { source: `${retired}/:appId`, destination: '/workspaces/:id/apps?app=:appId', permanent: false },
        { source: retired, destination: '/workspaces/:id/apps', permanent: false },
      ]),
    ]),
    // `/new` (the create page) is `/workspaces/new` now.
    { source: '/new', destination: '/workspaces/new', permanent: true },
    { source: '/projects', destination: '/workspaces', permanent: true },
    { source: '/projects/:path*', destination: '/workspaces/:path*', permanent: true },
    { source: '/admin/projects', destination: '/admin/workspaces', permanent: true },
    { source: '/admin/projects/:path*', destination: '/admin/workspaces/:path*', permanent: true },
    // A locale-prefixed app URL (`/de/projects/<id>`) keeps its locale.
    ...(['', '/admin'] as const).flatMap((area) => [
      { source: `${locale}${area}/projects`, destination: `/:locale${area}/workspaces`, permanent: true },
      { source: `${locale}${area}/projects/:path*`, destination: `/:locale${area}/workspaces/:path*`, permanent: true },
    ]),
    { source: `${locale}/new`, destination: '/:locale/workspaces/new', permanent: true },
  ];
}

/**
 * Runs in <head> before hydration. An installed desktop shell loads `/projects…`
 * and `/new` (served from the `/workspaces` pages by
 * {@link workspaceDesktopRewrites}); this shows the `/workspaces` URL with
 * `history.replaceState`, so the App Router hydrates on the canonical path
 * (usePathname reads `/workspaces/…`). A same-document URL change fires no
 * shell navigation gate. Other browsers never see these paths (308).
 */
export const DESKTOP_LEGACY_PATH_SCRIPT = `
(function() {
  try {
    var l = window.location, p = l.pathname, n = null;
    if (/^\\/projects(?=$|\\/)/.test(p)) n = p.replace(/^\\/projects/, '/workspaces');
    else if (p === '/new') n = '/workspaces/new';
    if (n) window.history.replaceState(window.history.state, '', n + l.search + l.hash);
  } catch (e) {}
})();
`.trim();
