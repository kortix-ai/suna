'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { DEFAULT_PROJECT_SETTINGS_TAB, projectSettingsHref } from '@/lib/project-nav';

/** /settings with no tab lands on General. */
export default function ProjectSettingsIndexPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params?.id ?? '';

  useEffect(() => {
    if (projectId) {
      router.replace(projectSettingsHref(projectId, DEFAULT_PROJECT_SETTINGS_TAB));
    }
  }, [projectId, router]);

  return null;
}
