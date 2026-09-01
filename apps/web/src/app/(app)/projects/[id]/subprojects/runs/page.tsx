import { SubprojectReportsView } from '@/features/subprojects/subproject-reports-view';

/**
 * `/projects/[id]/subprojects/runs` — every subproject's runs in this project.
 *
 * Under `subprojects/` rather than the old top-level `subproject-reports/`: a run report
 * is a view OF a subproject, and nesting it means the store's "Browse subprojects" link
 * and the report's back link describe the same hierarchy the URL does.
 */
export default async function ProjectSubprojectRunsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SubprojectReportsView projectId={id} />;
}
