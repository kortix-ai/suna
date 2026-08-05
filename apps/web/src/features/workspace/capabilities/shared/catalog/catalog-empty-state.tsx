import type { ReactNode } from 'react';

/**
 * The "nothing here" line every catalog uses, so five hand-typed copies of one
 * class string cannot drift into five different-looking messages. `CatalogGrid`
 * owns loading/error/empty; this is what callers put IN the empty slot when the
 * cause is the search box rather than an empty project.
 */
export function CatalogEmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-3 py-6 text-center text-xs">{children}</p>;
}

/**
 * "No matches for `<query>`."
 *
 * The query is trimmed HERE, once. Echoing it raw put the user's own trailing
 * spaces inside a monospace span, which reads as a rendering bug rather than as
 * a report of what was searched for.
 */
export function CatalogNoMatch({ query }: { query: string }) {
  return (
    <CatalogEmptyNote>
      No matches for <span className="text-foreground font-mono">{query.trim()}</span>.
    </CatalogEmptyNote>
  );
}
