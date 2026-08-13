'use client';

/**
 * /projects/[id]/customize — legacy deep-link entry into what is now the
 * Settings overlay. The Customize overlay itself no longer exists — it was
 * merged into Settings (see `features/workspace/settings/settings-panel.tsx`)
 * and this route is kept ONLY so old links / bookmarks keep working: it
 * resolves the legacy `?section=` query (if any) through
 * `legacySectionRedirect` — which folds every renamed/graduated legacy id
 * onto its current home — and replaces straight there. A bare `/customize`
 * (no section) or an unresolvable one falls back to the bare `/settings`
 * route, which opens on the default tab.
 */

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import { legacySectionRedirect } from '@/features/workspace/settings/settings-tabs';

export default function ProjectCustomizeRedirect() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (!projectId) return;
    const redirect =
      legacySectionRedirect(projectId, searchParams.get('section')) ??
      `/projects/${projectId}/settings`;
    router.replace(redirect);
  }, [projectId, searchParams, router]);

  return null;
}
