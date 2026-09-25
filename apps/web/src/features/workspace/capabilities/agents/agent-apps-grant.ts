/**
 * The Apps grant's pure half — what the Apps page of the agent editor shows,
 * with no React and no network, so it can be tested directly.
 *
 * `agents.<name>.apps` stores App SLUGS, never App ids (spec
 * `docs/specs/2026-09-22-agents-as-principals.md` §2.5, enforced by
 * `agentAppAccessDecision` in apps/api/src/apps/access.ts). A row's `id` is
 * therefore the slug: it is what the checkbox writes into the grant and what
 * the gate matches on. Keying a row on `app_id` produces a grant the gate
 * never matches, and nothing says so.
 */

import type { App, AppAccessMode } from '@kortix/sdk';

/** The access modes where the agent grant decides admission at all. A
 *  `project` App admits any agent holding `project.app.read`; `public` admits
 *  everyone; `password` admits no agent. */
const GRANT_DECIDES: readonly AppAccessMode[] = ['restricted', 'private'];

export interface AppGrantRow {
  /** The App slug — the value the grant stores. */
  id: string;
  name: string;
  /** True when this App's access mode makes the grant load-bearing. */
  needsGrant: boolean;
}

export function appGrantRows(apps: readonly App[] | undefined): AppGrantRow[] {
  return [...(apps ?? [])]
    .map((app) => ({
      id: app.slug,
      name: app.name || app.slug,
      needsGrant: GRANT_DECIDES.includes(app.access_mode),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
