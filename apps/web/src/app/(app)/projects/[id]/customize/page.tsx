'use client';

/**
 * /projects/[id]/customize — deep-link entry into the Customize overlay.
 *
 * Customize is now a full-screen overlay (see customize-store), not a route.
 * This page only exists so old links / bookmarks keep working: it opens the
 * overlay on the requested section (legacy `?section=` still honored) and drops
 * you on the project home behind it.
 */

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import { parseCustomizeSection } from '@/lib/customize-sections';
import { useCustomizeStore } from '@/stores/customize-store';

export default function ProjectCustomizeRedirect() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (!projectId) return;
    const section = parseCustomizeSection(searchParams.get('section')) ?? undefined;
    useCustomizeStore.getState().openCustomize(section);
    router.replace(`/projects/${projectId}`);
  }, [projectId, searchParams, router]);

  return null;
}
