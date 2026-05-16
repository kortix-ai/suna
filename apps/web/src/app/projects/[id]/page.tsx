import { redirect } from 'next/navigation';

// Project root redirects straight to the Files tab — the dashboard-style
// shell renders the nav + chrome via /projects/[id]/layout.tsx.
export default async function ProjectIndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/files`);
}
