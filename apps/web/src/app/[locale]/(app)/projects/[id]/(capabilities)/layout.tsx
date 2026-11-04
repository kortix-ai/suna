'use client';

import { useParams } from 'next/navigation';

import { CapabilityAccessGate } from '@kortix/ui/customize/shared/capability-access-gate';
import { CustomizeFrame } from '@kortix/ui/customize/shared/customize-tab-bar';

/**
 * Shared shell for /projects/[id]/customize/* (and the retired `members` and
 * `channels` redirects). The `(capabilities)` route group keeps the segment out
 * of the URL.
 *
 * The Customize bar is back on top (Jay, 2026-10-29: prod's layout): Agents,
 * the libraries, Review, Members and Settings in one row of tabs
 * (`CustomizeFrame`). Project admin renders the same bar, so it stays put
 * between the two route trees. The bar holds the sidebar opener; the page
 * headers below it drop theirs.
 *
 * **`h-svh` bounds the page.** Nothing above this box has a definite height
 * (`<body>` is `min-height: 100dvh`, the sidebar wrapper `min-h-svh`), so
 * without it the page's own `overflow-y-auto` scroller would never bound and
 * the window would scroll instead. `svh` assumes mobile browser chrome is
 * visible, so content is never pushed under a toolbar that reappears.
 *
 * **One access rule for the sidebar and the body.** `CapabilityAccessGate`
 * renders `{children}` only for a page `capabilityAccess()` allows and
 * replaces any other URL with the first allowed page or the project home.
 */
export default function CapabilitiesLayout({ children }: { children: React.ReactNode }) {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <CustomizeFrame projectId={projectId}>
        <CapabilityAccessGate projectId={projectId}>{children}</CapabilityAccessGate>
      </CustomizeFrame>
    </div>
  );
}
