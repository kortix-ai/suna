'use client';

/**
 * /workspaces/[id]/customize — deep-link entry into the Customize overlay.
 *
 * Customize is now a full-screen overlay (see customize-store), not a route.
 * This page only exists so old links / bookmarks keep working: it opens the
 * overlay on the requested section (legacy `?section=` still honored) and drops
 * you on the workspace home behind it.
 */

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { legacyCustomizeRedirect, parseCustomizeSection } from '@/lib/customize-sections';
import { useCustomizeStore } from '@/stores/customize-store';

export default function WorkspaceCustomizeRedirect() {
  const params = useParams<{ id: string }>();
  const workspaceId = params?.id ?? '';
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (!workspaceId) return;
    // Files, Changes, Connectors, Skills, and Commands graduated out of
    // Customize into their own standalone pages. Preserve old bookmarks.
    const redirect = legacyCustomizeRedirect(workspaceId, searchParams.get('section'));
    if (redirect) {
      router.replace(redirect);
      return;
    }
    const section = parseCustomizeSection(searchParams.get('section')) ?? undefined;
    useCustomizeStore.getState().openCustomize(section);
    router.replace(`/workspaces/${workspaceId}`);
  }, [workspaceId, searchParams, router]);

  return null;
}
