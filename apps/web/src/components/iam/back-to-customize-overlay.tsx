'use client';

/**
 * `BackToCustomizeOverlay` — the way back to the project you came from, and
 * deliberately NOT part of the account hub's layout.
 *
 * ## Why it exists
 *
 * The Customize bar's "Members" link leaves a project for
 * `/accounts/<id>?tab=access-projects&project=<pid>`
 * (`capabilities/shared/capability-tabs.tsx`). The panel there offers "‹ All
 * projects", which walks UP to the hub's project picker — a level above the
 * project you started on, and somewhere you have never been. The trip was
 * one-way.
 *
 * ## Why it floats
 *
 * The account hub is the ACCOUNT's screen. A "Back to Customize" row wedged
 * into its header would be permanent chrome describing a temporary situation,
 * and it would take a row from everyone who never came from a project. So this
 * is `fixed` and out of flow: nothing on the page moves whether it renders or
 * not. Measured on localhost:18000 — hiding it leaves the pane heading at
 * `top: 58` and `scrollHeight` unchanged.
 *
 * Bottom-left, not top-left: the top-left of that page is the account rail and
 * its identity block, and an overlay there would sit on top of them. The bottom
 * corner is empty on every section of the hub. It centres itself below `sm`,
 * where the rail is a horizontal strip and the left corner is not reserved.
 *
 * ## Why `router.back()` and not an href
 *
 * It returns to the exact Customize tab the person left — Models, Connectors,
 * Skills, Triggers, Secrets, Settings — which no single URL can name. That is
 * safe here because `?from=customize` is set by ONE link, so the entry is
 * always in history; nothing else in the app produces that param.
 */

import { CaretLeftIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';

export function BackToCustomizeOverlay() {
  const router = useRouter();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4 sm:inset-x-auto sm:left-6 sm:justify-start sm:px-0">
      <button
        type="button"
        onClick={() => router.back()}
        className="bg-background/80 text-muted-foreground hover:text-foreground border-border pointer-events-auto flex items-center gap-1.5 rounded-full border py-2 pr-4 pl-3 text-sm shadow-sm backdrop-blur-md transition-colors"
      >
        <CaretLeftIcon className="size-3.5 shrink-0" />
        Back to Customize
      </button>
    </div>
  );
}
