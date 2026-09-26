import type { Metadata } from 'next';
import Link from 'next/link';

import { DEBUG_ROUTE_GROUPS, DEBUG_ROUTES } from './debug-routes';

/**
 * /debug — index of every visual harness in this folder.
 *
 * The list comes from `debug-routes.ts`, not from the filesystem: the
 * standalone build ships without `src/`, so a request-time `readdir` works in
 * dev and breaks after deploy. `debug-routes.test.ts` keeps the list and the
 * folders in sync instead.
 */

export const metadata: Metadata = { title: 'Debug' };

export default function DebugIndexPage() {
  return (
    <div className="bg-background min-h-dvh antialiased">
      <div className="mx-auto w-full max-w-2xl space-y-8 px-4 py-10 pb-20 lg:py-20">
        <header className="space-y-1">
          <h1 className="text-foreground text-xl font-medium">Debug</h1>
          <p className="text-muted-foreground text-sm text-pretty">
            Visual harnesses for UI that is hard to reach in a live session. None of these pages is
            linked from the app.
          </p>
        </header>

        {DEBUG_ROUTE_GROUPS.map((group) => {
          const routes = DEBUG_ROUTES.filter((route) => route.group === group);
          const headingId = `debug-group-${group.toLowerCase()}`;

          return (
            <section key={group} aria-labelledby={headingId} className="space-y-3">
              <h2 id={headingId} className="text-foreground text-sm font-medium">
                {group}
              </h2>
              <ul role="list" className="space-y-2">
                {routes.map((route) => (
                  <li key={route.slug}>
                    {/* No prefetch: these are heavy harness bundles, and a visitor opens one. */}
                    <Link
                      href={`/debug/${route.slug}`}
                      prefetch={false}
                      className="bg-popover hover:bg-hover focus-visible:ring-ring flex flex-col gap-0.5 rounded-md border px-4 py-2.5 outline-none focus-visible:ring-2"
                    >
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="text-foreground min-w-0 truncate text-sm font-medium">
                          {route.title}
                        </span>
                        <span className="text-muted-foreground shrink-0 font-mono text-xs max-sm:hidden">
                          /debug/{route.slug}
                        </span>
                      </span>
                      <span className="text-muted-foreground text-xs text-pretty">
                        {route.description}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
