import { redirect } from 'next/navigation';

import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';

/** Files moved under Customize; `/drive` links and bookmarks land there. */
export default async function ProjectFilesDrivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(capabilityTabHref(id, 'files'));
}
