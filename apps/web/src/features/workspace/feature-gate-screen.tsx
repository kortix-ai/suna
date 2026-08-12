'use client';

import { Button } from '@/components/ui/button';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { FlagIcon } from '@phosphor-icons/react';

/**
 * The one screen a flag-gated surface shows when its feature is OFF.
 *
 * It never offers to enable the feature. Activation happens in exactly one
 * place — Settings → Experimental — so there is a single control, a single
 * permission leaf (`project.customize.write`), and no per-feature switch to
 * hunt for. The button here just takes you there.
 *
 * `main` shipped this pointing at the Customize overlay's Feature flags
 * section (`openCustomize('feature-flags')`); that overlay is gone, and the
 * flag list lives on the settings panel's Experimental tab, so the button
 * opens that instead. Same destination content, same single control.
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
  const openSettings = useSettingsPanelStore((state) => state.openSettings);

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
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => openSettings('experimental')}
        >
          Feature flags
        </Button>
      </div>
    </div>
  );
}
