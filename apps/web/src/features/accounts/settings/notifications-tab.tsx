'use client';

/**
 * `NotificationToggle` — one labeled switch row. This file used to also
 * export a full `NotificationsTab` (the enable-notifications switch plus the
 * per-event toggle groups) that backed the legacy user-settings modal.
 * Task 10 deleted that modal; `NotificationsTab` lost its only
 * consumer and was removed with it — same treatment as `AppearanceTab` in
 * `appearance-tab.tsx`, see that file's header for the reasoning this
 * mirrors. This file survives because `NotificationToggle` still has a real,
 * live consumer: `features/workspace/settings/tabs/preferences-tab.tsx`.
 */

import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { type Icon as IconType, type Icon as LucideIcon, type Icon as MynaIcon } from '@phosphor-icons/react';

interface NotificationToggleProps {
  icon: LucideIcon | MynaIcon | IconType;
  label: string;
  description: string;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  disabled?: boolean;
  /**
   * Prefixes the generated `id`/`htmlFor` pair. Defaults to `''` — this
   * component's original behavior, `id={label}`. `features/workspace/
   * settings/tabs/preferences-tab.tsx` passes `pref-notif-` so its copy of
   * this row can mount in the same document as this one (both are reachable
   * from the same account, e.g. one open in a background tab) without two
   * elements sharing one DOM id.
   */
  idPrefix?: string;
}

/** Exported so `features/workspace/settings/tabs/preferences-tab.tsx` can
 *  reuse this row instead of re-implementing it — see that file's header
 *  for why this tab still imports pieces of this one rather than
 *  duplicating them, mirroring the `WallpaperCard` export in
 *  `appearance-tab.tsx`. */
export function NotificationToggle({
  icon: Icon,
  label,
  description,
  enabled,
  onToggle,
  disabled,
  idPrefix = '',
}: NotificationToggleProps) {
  const id = `${idPrefix}${label}`;
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="flex flex-1 items-start gap-3">
        <Icon className="text-muted-foreground mt-1 size-4" />
        <div className="flex-1 space-y-0.5">
          <Label htmlFor={id} className="cursor-pointer text-sm font-medium">
            {label}
          </Label>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
      </div>
      <Switch id={id} checked={enabled} onCheckedChange={onToggle} disabled={disabled} />
    </div>
  );
}

