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
export function CatalogNoMatch({
  query,
  excludedNoActions = 0,
}: {
  query: string;
  /**
   * Apps that matched but expose no actions, so the catalogue does not offer
   * them.
   *
   * Without this the page reports a flat "No matches for SAP" — which is wrong
   * twice, because `sap_s_4hana_cloud` and `sap_s_4hana_cloud_sandbox` both
   * exist upstream and the reason they are absent is one we can state.
   * Reporting a bare zero is what made the catalogue look broken rather than
   * selective.
   */
  excludedNoActions?: number;
}) {
  return (
    <CatalogEmptyNote>
      No matches for <span className="text-foreground font-mono">{query.trim()}</span>.
      {excludedNoActions > 0 ? (
        <>
          {' '}
          {excludedNoActions === 1 ? '1 app matches' : `${excludedNoActions} apps match`} but
          publish{excludedNoActions === 1 ? 'es' : ''} no actions an agent can call.
        </>
      ) : null}
    </CatalogEmptyNote>
  );
}
