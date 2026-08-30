import { notFound } from 'next/navigation';

import { CraftReportDetail } from '@/features/crafts/craft-report-detail';
import { craftReportById } from '@/features/crafts/craft-runs';

export default async function ProjectCraftReportPage({
  params,
}: {
  params: Promise<{ id: string; craftId: string }>;
}) {
  const { id, craftId } = await params;
  // Existence check via the CATALOG-FREE half of the data layer:
  // `crafts-catalog` imports Phosphor icon values, which call `createContext`
  // at module scope and crash an RSC build. The craft join happens inside the
  // client component instead.
  //
  // This renders `projects/[id]/not-found.tsx` under a 200, not a 404:
  // `projects/[id]/layout.tsx` streams, so the headers are flushed before this
  // line runs. Moving the call into `generateMetadata` was tried and does not
  // change it. An unmatched route under the same shell still 404s properly,
  // because that decision happens in the router. Verified, not assumed.
  if (!craftReportById(craftId)) notFound();
  return <CraftReportDetail projectId={id} craftId={craftId} />;
}
