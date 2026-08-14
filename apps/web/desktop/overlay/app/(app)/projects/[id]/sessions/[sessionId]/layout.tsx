import type { ReactNode } from 'react';

import { SessionTabTitleSyncFromUrl } from './title-sync-client';

/**
 * Desktop overlay for the session route shell.
 *
 * The web version owns the tab title through `generateMetadata`, which calls
 * `resolveSessionTabTitle` on the server. Neither survives static export: the
 * route is prerendered once against `__shell__`, so a build-time title would be
 * wrong for every real session, and there is no server to resolve it at
 * request time.
 *
 * The web file's own comment explains why a client effect loses on the web —
 * React re-asserts the metadata-owned <title> after effects run, overwriting a
 * `document.title` write. That race does not exist here: with no
 * `generateMetadata` in the desktop bundle, nothing re-asserts the title, so
 * the client sync owns it outright. `SessionTabTitleSync` already existed for
 * post-load renames; the desktop wrapper below just also owns the first paint.
 *
 * Stays a server component so desktop/build.mjs can append
 * `generateStaticParams` to it.
 */
export default function SessionRouteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <SessionTabTitleSyncFromUrl />
    </>
  );
}
