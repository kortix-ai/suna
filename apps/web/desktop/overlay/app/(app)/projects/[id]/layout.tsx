import type { ReactNode } from 'react';

import { ProjectLayoutClient } from './layout-client';

/**
 * Desktop overlay for the /projects/[id] shell.
 *
 * Two differences from the web version, both forced by static export:
 *
 * 1. No `await cookies()`. That call exists on web purely to opt the subtree
 *    into dynamic rendering; a static export has no request to read.
 * 2. `params` is not read here. The route is prerendered once against the
 *    `__shell__` placeholder, so the build-time `params` value is meaningless —
 *    the real project id has to come from the URL at render time. That makes it
 *    a client concern, hence the split below.
 *
 * This file stays a server component so desktop/build.mjs can append
 * `generateStaticParams` to it.
 */
export default function ProjectLayout({ children }: { children: ReactNode }) {
  return <ProjectLayoutClient>{children}</ProjectLayoutClient>;
}
