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
export interface Redirect {
  source: string;
  destination: string;
  permanent: boolean;
  has?: { type: 'query'; key: string; value: string }[];
}

export function workspaceRedirects(locales: readonly string[]): Redirect[] {
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
