'use client';

/**
 * /projects/[id]/settings — the project's settings.
 *
 * The project's own settings page is `/customize/settings` (General, Git
 * repository, Sandbox templates, Feature flags, Upgrades). This URL used to
 * open the merged ACCOUNT settings overlay on Profile instead, so a person
 * looking for "Delete project" met a danger zone that offered "Delete
 * account" (KRTX-2491). It is also where the project-scoped fallbacks land
 * (`/settings/<unknown tab>`, `/customize/<unknown section>`, `/members`), so
 * they now land on the project's settings too.
 *
 * Account tabs keep their deep links: `/projects/[id]/settings/[tab]` opens
 * the overlay on that tab.
 */

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function ProjectSettingsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  const router = useRouter();

  useEffect(() => {
    if (!projectId) return;
    router.replace(`/projects/${projectId}/customize/settings`);
  }, [projectId, router]);

  return null;
}
