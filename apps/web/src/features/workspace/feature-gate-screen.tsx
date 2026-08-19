'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { projectSettingsSectionHref } from '@/features/workspace/capabilities/project-settings/project-settings-sections';
import { FlagIcon } from '@phosphor-icons/react';

/**
 * The one screen a flag-gated surface shows when its feature is OFF.
 *
 * It never offers to enable the feature. Activation happens in exactly one
 * place — Customize → Settings → Feature flags — so there is a single
 * control, a single permission leaf (`project.customize.write`), and no
 * per-feature switch to hunt for. The button here just takes you there.
 *
 * The destination has moved twice and the content never has: the legacy
 * Customize overlay's `feature-flags` section, then the settings overlay's
 * Experimental tab, and now `/projects/<id>/config?section=feature-flags`.
 * A real `<Link>`, because it is a route now — middle-click and copy-link
 * both work, and the page prefetches.
 *
 * Only reachable surfaces render this. A gated NAV entry, palette action, or
 * rail item must be absent entirely when its flag is off; this is for the case
 * a user still lands on the page (a bookmark, a shared link, a deep link).
 */
export function FeatureGateScreen({
  featureName,
  description,
}: {
  /** The feature's name, exactly as the Feature flags section lists it. */
  featureName: string;
  /** One sentence: what turning it on would give this project. */
  description: string;
}) {
  const params = useParams<{ id: string }>();
  const projectId = params?.id;

  return (
    <div className="bg-popover rounded-md border px-4 py-5">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="bg-muted/50 flex size-9 shrink-0 items-center justify-center rounded-sm">
            <FlagIcon className="text-muted-foreground size-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-foreground text-sm font-medium">
              {featureName} is off for this project
            </p>
            <p className="text-muted-foreground max-w-xl text-xs text-pretty">{description}</p>
          </div>
        </div>
        {projectId ? (
          <Button asChild size="sm" variant="secondary" className="shrink-0">
            <Link href={projectSettingsSectionHref(projectId, 'feature-flags')}>Feature flags</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
