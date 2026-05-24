'use client';

/**
 * /projects/[id]/customize/[section] — deep-link entry into the Customize
 * overlay for a specific section (e.g. `/customize/skills`).
 *
 * Customize is now a full-screen overlay (see customize-store), not a route.
 * This page exists only so bookmarks / Cmd+K deep links keep working: it opens
 * the overlay on the requested section and drops you on the project home behind
 * it.
 */

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import { parseCustomizeSection } from '@/lib/customize-sections';
import { useCustomizeStore } from '@/stores/customize-store';

export default function ProjectCustomizeSectionRedirect() {
  const params = useParams<{ id: string; section: string }>();
  const projectId = params?.id ?? '';
  const rawSection = params?.section;
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (!projectId) return;
    const section =
      parseCustomizeSection(rawSection) ??
      parseCustomizeSection(searchParams.get('section')) ??
      undefined;
    useCustomizeStore.getState().openCustomize(section);
    router.replace(`/projects/${projectId}`);
  }, [projectId, rawSection, searchParams, router]);

  return null;
}
