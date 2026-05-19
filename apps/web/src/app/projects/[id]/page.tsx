import { redirect } from 'next/navigation';

// Project root lands on the sessions list — Files moved into the Customize
// modal, so we no longer redirect users there as the default surface.
export default async function ProjectIndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/sessions`);
}
