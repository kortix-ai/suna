'use client';

/**
 * Toolbar controls shared by the panel's two file toolbars — `FileViewer`
 * (text) and `PreviewShell` (everything else).
 *
 * Both toolbars are deliberately identical so the actions never move between
 * file types. That contract only holds if they render the SAME controls, not
 * two copies that drift apart the first time either is touched.
 */

import { PublicShareLinkButton } from '@/components/projects/public-share-link-button';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { useIsExpanded, useToggleExpanded } from '@/stores/kortix-computer-store';
import { ChevronsLeftRight, ChevronsRightLeft } from 'lucide-react';

/** Project-session ids a share link is scoped to. */
export interface ShareContext {
  projectId: string;
  sessionId: string;
}

/**
 * Copy a public, view-only link to this file. Rendered only when the session
 * has project context — a booting or transient session has none, and an
 * omitted control beats a disabled one with no explanation (W4), matching
 * `OpenInNewTabButton` and `CopyImageButton`.
 */
export function ShareFileButton({
  shareContext,
  path,
  fileName,
}: {
  shareContext?: ShareContext;
  path?: string;
  fileName: string;
}) {
  if (!shareContext || !path) return null;

  return (
    // PublicShareLinkButton's defaults (16px icon, no press feedback, Radix's
    // default tooltip offset) are tuned for the standalone /files modal, not
    // this row — the toolbar's uniformity contract requires every icon button
    // here to match its siblings exactly, so override all three.
    <PublicShareLinkButton
      projectId={shareContext.projectId}
      sessionId={shareContext.sessionId}
      input={{ file: { label: fileName, path }, mode: 'view' }}
      tooltip="Copy a public view-only link"
      className="text-muted-foreground hover:text-foreground size-7 active:scale-[0.96]"
      iconClassName="size-3.5"
      tooltipSideOffset={10}
    />
  );
}

/**
 * Widen the side panel to fill the window, and back.
 *
 * This is NOT full screen, and must not borrow full screen's glyph: it changes
 * how much room the panel takes, while the document keeps its own frame.
 * Sharing `Maximize2` between the two is why the real full-screen viewer read
 * as missing rather than as moved.
 *
 * Absent on mobile, where the drawer never reads `isExpanded` and the control
 * would be dead weight.
 */
export function PanelWidthButton({ isMobile }: { isMobile: boolean }) {
  const isExpanded = useIsExpanded();
  const toggleExpanded = useToggleExpanded();

  if (isMobile) return null;

  const label = isExpanded ? 'Restore panel width' : 'Widen panel';

  return (
    <Hint label={label} side="bottom">
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleExpanded}
        aria-label={label}
        className="size-7 active:scale-[0.96]"
      >
        {isExpanded ? (
          <ChevronsRightLeft className="size-3.5" />
        ) : (
          <ChevronsLeftRight className="size-3.5" />
        )}
      </Button>
    </Hint>
  );
}
