import { CraftReportsView } from '@/features/crafts/craft-reports-view';

/**
 * `/projects/[id]/crafts/runs` — every craft's runs in this project.
 *
 * Under `crafts/` rather than the old top-level `craft-reports/`: a run report
 * is a view OF a craft, and nesting it means the store's "Browse crafts" link
 * and the report's back link describe the same hierarchy the URL does.
 */
export default async function ProjectCraftRunsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CraftReportsView projectId={id} />;
}
