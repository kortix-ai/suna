import { redirect } from 'next/navigation';

import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';

/**
 * `/projects/[id]/subprojects` — retired, and kept only to forward.
 *
 * The store is the **Marketplace** capability tab now
 * (`/projects/[id]/marketplace`), under Customize with Models / Connectors /
 * Agents / Skills / Triggers. It had its own sidebar row and its own top-level
 * segment; both are gone, because installing a subproject is configuration, not
 * a place you navigate to.
 *
 * A server redirect rather than a `router.replace` effect — the target needs no
 * per-project data, so resolving it on the server means the browser never
 * paints a page it is about to leave. Same pattern as
 * `(capabilities)/channels/page.tsx`.
 *
 * Deleting the folder outright was the alternative and is the wrong one — a URL
 * that worked this morning would 404 this afternoon, silently, for anyone who
 * had saved it. `subprojects/runs` and `subprojects/runs/[subprojectSlug]` were
 * retired outright rather than forwarded: run monitoring is no longer a
 * subproject-scoped surface at all, so there is no equivalent page to send
 * those URLs to.
 *
 * `capabilityTabHref` builds the target rather than interpolation, so renaming
 * or dropping the Marketplace tab fails this line at compile time instead of
 * leaving a redirect to a 404. The import is safe in a server component:
 * `capability-tab-routes` is pure data with no icon import.
 */
export default async function RetiredProjectSubprojectsRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(capabilityTabHref(id, 'marketplace'));
}
