import { CraftReportDetail } from '@/features/crafts/craft-report-detail';

/**
 * `/projects/[id]/crafts/runs/[craftSlug]` — one craft's run history.
 *
 * No server-side existence check, deliberately. The craft slug names an entry
 * in the PROJECT'S manifest, which this page cannot read without the request's
 * auth, and a craft with zero runs is a legitimate page rather than a 404. The
 * client component says which of the three it is: runs, "no runs yet", or "no
 * longer in the manifest".
 *
 * The previous version called `notFound()` against a hardcoded mock. That check
 * also never produced a real 404 — `projects/[id]/layout.tsx` streams, so the
 * headers are already flushed and `not-found.tsx` renders under a 200.
 */
export default async function ProjectCraftRunPage({
  params,
}: {
  params: Promise<{ id: string; craftSlug: string }>;
}) {
  const { id, craftSlug } = await params;
  return <CraftReportDetail projectId={id} craftSlug={craftSlug} />;
}
