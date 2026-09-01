import { SubprojectReportDetail } from '@/features/subprojects/subproject-report-detail';

/**
 * `/projects/[id]/subprojects/runs/[subprojectSlug]` — one subproject's run history.
 *
 * No server-side existence check, deliberately. The subproject slug names an entry
 * in the PROJECT'S manifest, which this page cannot read without the request's
 * auth, and a subproject with zero runs is a legitimate page rather than a 404. The
 * client component says which of the three it is: runs, "no runs yet", or "no
 * longer in the manifest".
 *
 * The previous version called `notFound()` against a hardcoded mock. That check
 * also never produced a real 404 — `projects/[id]/layout.tsx` streams, so the
 * headers are already flushed and `not-found.tsx` renders under a 200.
 */
export default async function ProjectSubprojectRunPage({
  params,
}: {
  params: Promise<{ id: string; subprojectSlug: string }>;
}) {
  const { id, subprojectSlug } = await params;
  return <SubprojectReportDetail projectId={id} subprojectSlug={subprojectSlug} />;
}
