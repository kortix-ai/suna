import { redirect } from 'next/navigation';

/**
 * Retired route. Customize is one surface again, so this section lives in its
 * rail rather than at its own top-level URL. Kept as a redirect because these
 * URLs were shipped and are linked from the command palette and menu registry.
 */
export default async function RetiredSectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/projects/${id}/customize/settings`);
}
