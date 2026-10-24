'use client';

import { useParams } from 'next/navigation';

import { CapabilityAccessGate } from '@kortix/ui/customize/shared/capability-access-gate';

/**
 * Shared shell for /projects/[id]/customize/* (and the retired `members` and
 * `channels` redirects). The `(capabilities)` route group keeps the segment out
 * of the URL.
 *
 * Customize has no top bar (Marko, 2026-10-24: "remove the customize topbar and
 * give it space to edit"). Its navigation lives in the sidebar's Customize
 * group: My Kortix, the agents, New agent, Review and Settings (Project admin,
 * where Members also lives). Each page draws its own header and its own
 * sidebar opener: the agent page in its identity header, every other page in
 * `CapabilityPageShell`.
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
      <CapabilityAccessGate projectId={projectId}>{children}</CapabilityAccessGate>
    </div>
  );
}
