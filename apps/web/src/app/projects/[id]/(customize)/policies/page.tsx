/**
 * Policies moved under Connectors → Policies tab. This route stays only as a
 * redirect so deep links + the command palette's historical entries don't 404.
 */
import { redirect } from 'next/navigation';

export default async function ProjectPoliciesRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/customize/connectors?tab=policies`);
}
