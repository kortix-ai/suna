'use client';

/**
 * /projects/[id]/customize/[section] — the canonical deep link into a
 * Customize pane (e.g. `/customize/secrets`, `/customize/agents`). Also the
 * landing spot for every legacy Customize-overlay id, which
 * `legacySectionRedirect` folds onto its current pane.
 *
 * A segment that names a Settings pane opens Settings instead — the tab owns
 * its surface, not the URL. See `panel-deep-link.tsx`.
 */

import { useParams } from 'next/navigation';

import { PanelDeepLink } from '@/features/workspace/settings/panel-deep-link';

export default function ProjectCustomizeSectionPage() {
  const params = useParams<{ section: string }>();
  return <PanelDeepLink segment={params?.section} fallbackSurface="customize" />;
}
