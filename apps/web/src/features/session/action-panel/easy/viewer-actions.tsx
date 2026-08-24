'use client';

/**
 * Toolbar controls shared by the detail layer's three viewers — `FileViewer`
 * (text), `PreviewShell` (everything else) and `AppPreview` (a running port).
 *
 * All three are deliberately identical so the actions never move between one
 * output and the next. That contract only holds if they render the SAME
 * controls, not three copies that drift apart the first time any is touched.
 *
 * ─── Why one split button instead of a row of icons ────────────────────────
 *
 * This bar used to be six flat icon peers — ask for changes, copy, open in a
 * new tab, copy link, download, full screen — plus close. Seven glyphs with no
 * hierarchy: every action shouted at the same volume, so none of them read as
 * *the* action, and three of them ("copy" vs "copy link" vs "open in a tab")
 * were mutually indistinguishable at 14px.
 *
 * Now there is one labelled control and one caret:
 *
 *     [  Copy  |ᵛ]   [⤢]   [✕]
 *
 * `Copy` says in words what it does, so it needs no tooltip, no icon, and
 * cannot be confused with its neighbours. The word alone also carries the
 * confirmation — it flips to `Copied`. Everything else that is a way of *taking this
 * output with you* lives behind the caret. Full screen and close stay outside —
 * they act on the panel, not on the output, and the panel's controls belong at
 * the panel's edge.
 *
 * ─── The one rule that decides the primary label ───────────────────────────
 *
 * The primary is the first of these the surface can actually do:
 *
 *   1. `Copy`      — the output's own content (a file's text, an image's pixels)
 *   2. `Copy link` — a public, view-only link
 *   3. `Download`  — the bytes
 *
 * and the menu holds every one it did NOT take, always in that same order. So
 * the label always tells the truth about what a click does, the group never
 * moves, and no surface ever shows a control that would be a no-op. A PDF has
 * no content to put on a clipboard, so its primary is `Copy link`; a text file
 * has, so `Copy link` drops into its menu.
 */

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { downloadFile } from '@/features/files/api/runtime-files';
import { usePublicShareLink } from '@/hooks/use-public-share-link';
import { track } from '@/lib/track';
import { cn } from '@/lib/utils';
import { useIsExpanded, useToggleExpanded } from '@/stores/kortix-computer-store';
import type { CreateSessionPublicShareInput } from '@kortix/sdk';
import {
  CaretDownIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  LinkSimpleIcon,
  ArrowsOutSimpleIcon as Maximize2,
  ArrowsInSimpleIcon as Minimize2,
} from '@phosphor-icons/react';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

/** Project-session ids a share link is scoped to. */
export interface ShareContext {
  projectId: string;
  sessionId: string;
}

/**
 * The output's own content, put on the clipboard. `run` throwing is treated as
 * "did not copy" — no check, no toast: matching the rest of this panel's copy
 * affordances, which stay quiet on a denied clipboard permission rather than
 * raising an error for a low-stakes action.
 */
export interface ViewerCopy {
  run: () => void | Promise<void>;
  /** For screen readers, where the button's own word is only ever "Copy". */
  ariaLabel: string;
}

/** The bytes behind this output, for the `Download file` action. */
export interface ViewerDownload {
  path: string;
  fileName: string;
}

/**
 * Download fetches the file's real bytes before the browser's save dialog can
 * appear, so on anything bigger than a note there is a real wait. Without a
 * pending state the control looks broken and gets invoked again — which starts
 * a second fetch. Owned here rather than by the menu item because the menu
 * closes on select: the spinner has to land somewhere still on screen, which is
 * the caret.
 */
function useDownload(download?: ViewerDownload) {
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (!download || pending) return;
    setPending(true);
    try {
      await downloadFile(download.path, download.fileName);
      track('deliverable_downloaded', { scope: 'one' });
    } catch {
      // The browser reports its own failure; the control just needs to recover.
    } finally {
      if (alive.current) setPending(false);
    }
  }, [download, pending]);

  return { pending, run };
}

/**
 * What a public share for a workspace file describes. Both file toolbars build
 * it the same way — a file with no path cannot be shared, and `null` is what
 * withholds `Copy link` for that case.
 */
export function fileShareInput(
  path: string | undefined,
  label: string,
): CreateSessionPublicShareInput | null {
  return path ? { mode: 'view', file: { label, path } } : null;
}

/**
 * `Copy` and everything else you can do with this output, as one split button.
 *
 * Self-gating: hand it whatever the surface has and it works out the shape. A
 * surface with exactly one action renders a lone button and no caret — a menu
 * holding a single item is a click for nothing.
 */
export function ViewerActions({
  copy,
  shareContext,
  shareInput,
  download,
  extraMenuItems,
  className,
}: {
  /** Omit where the output has no content a clipboard can hold — a PDF, a
   *  spreadsheet, a running app. */
  copy?: ViewerCopy;
  /** Absent on a booting or transient session, which is why `Copy link` is
   *  omitted rather than disabled there (W4). */
  shareContext?: ShareContext;
  /** What the public share describes. Null suppresses `Copy link` for the same
   *  reason `shareContext` does. */
  shareInput: CreateSessionPublicShareInput | null;
  /** Omit where there are no bytes to save — a running app. */
  download?: ViewerDownload;
  /** Rendered at the end of the menu. `AppPreview` puts "Open in a new tab"
   *  here: it is the only surface where a real browser tab shows something the
   *  panel cannot. */
  extraMenuItems?: React.ReactNode;
  className?: string;
}) {
  const share = usePublicShareLink({
    projectId: shareContext?.projectId,
    sessionId: shareContext?.sessionId,
    input: shareInput,
  });
  const dl = useDownload(download);

  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const runCopy = useCallback(async () => {
    if (!copy) return;
    try {
      await copy.run();
    } catch {
      // Clipboard denied — the button simply doesn't confirm.
      return;
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  }, [copy]);

  const canCopyLink = share.canShare;

  // The rule from this file's header, written once. `primary` takes the first
  // available action; `menu` gets every one it left behind, in the same order.
  const primary = copy
    ? ({ kind: 'copy' } as const)
    : canCopyLink
      ? ({ kind: 'link' } as const)
      : download
        ? ({ kind: 'download' } as const)
        : null;

  const menu: React.ReactNode[] = [];
  if (canCopyLink && primary?.kind !== 'link') {
    menu.push(
      <DropdownMenuItem
        key="link"
        disabled={share.isPending}
        onSelect={() => {
          track('deliverable_link_copied');
          share.copyLink();
        }}
      >
        <LinkSimpleIcon />
        Copy link
      </DropdownMenuItem>,
    );
  }
  if (download && primary?.kind !== 'download') {
    menu.push(
      <DropdownMenuItem key="download" disabled={dl.pending} onSelect={() => void dl.run()}>
        <DownloadSimpleIcon />
        Download file
      </DropdownMenuItem>,
    );
  }
  if (extraMenuItems) menu.push(<Fragment key="extra">{extraMenuItems}</Fragment>);

  // No primary is possible on exactly one surface: an app in a session that has
  // no project context yet, so there is no link to copy and no file to save,
  // but "Open in a new tab" still works. A lone menu keeps that reachable
  // rather than blanking the toolbar.
  if (!primary) {
    if (menu.length === 0) return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="More actions"
            className={cn('shrink-0 active:scale-[0.96]', className)}
          >
            <DotsThreeIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {menu}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // Each async action reports in exactly one place: on the primary when it IS
  // the primary, on the caret when it lives in the menu (by which point the
  // menu has closed and the caret is the only thing left on screen). Without
  // the second half of each clause a link mint spun both at once.
  const primaryBusy =
    (primary.kind === 'link' && share.isPending) || (primary.kind === 'download' && dl.pending);
  const menuBusy =
    (primary.kind !== 'link' && share.isPending) || (primary.kind !== 'download' && dl.pending);

  // ─── The primary is a word, and only a word. ───────────────────────────
  // No icon: an icon beside a label that already says "Copy" is decoration,
  // and it was decoration that made this toolbar unreadable in the first
  // place. That leaves the label itself to carry the confirmation — it flips
  // to "Copied", which is louder and clearer than a 14px check ever was, and
  // reads to a screen reader without a live region.
  //
  // The group is right-anchored inside a `justify-between` row, so the extra
  // two characters extend the button's LEFT edge; the caret, full screen and
  // close do not move.
  const justDone = primary.kind === 'copy' ? copied : primary.kind === 'link' && share.copied;
  const primaryLabel = justDone
    ? 'Copied'
    : primary.kind === 'copy'
      ? 'Copy'
      : primary.kind === 'link'
        ? 'Copy link'
        : 'Download';

  const onPrimary = () => {
    if (primary.kind === 'copy') return void runCopy();
    if (primary.kind === 'link') {
      track('deliverable_link_copied');
      return share.copyLink();
    }
    return void dl.run();
  };

  const primaryButton = (
    <Button
      variant="outline"
      size="toolbar"
      onClick={onPrimary}
      disabled={primaryBusy}
      aria-label={justDone || primary.kind !== 'copy' ? primaryLabel : copy!.ariaLabel}
      aria-busy={primaryBusy}
      className="active:scale-[0.96] disabled:opacity-100"
    >
      {/* `Loading` is the one thing that still renders inside the button, and
          it is a spinner rather than an icon: a fetch the user is waiting on
          has to say so. */}
      {primaryBusy && (
        <Loading className="text-muted-foreground size-3.5 shrink-0 motion-reduce:animate-none" />
      )}
      {primaryLabel}
    </Button>
  );

  // A lone action needs no caret — an empty menu is a click that leads nowhere.
  if (menu.length === 0) {
    return <span className={cn('flex shrink-0 items-center', className)}>{primaryButton}</span>;
  }

  return (
    <ButtonGroup className={cn('shrink-0', className)}>
      {primaryButton}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            aria-label="More actions"
            className="active:scale-[0.96]"
          >
            {/* The caret carries the pending state for anything started from
                the menu — by then the menu itself has closed. */}
            {menuBusy ? (
              <Loading className="text-muted-foreground size-3.5 shrink-0 motion-reduce:animate-none" />
            ) : (
              <CaretDownIcon className="size-3.5" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {menu}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

/**
 * Expand the side panel to fill the window, and back.
 *
 * Absent on mobile, where the drawer never reads `isExpanded` and the control
 * would be dead weight. Self-gating so every toolbar can mount it the same way.
 */
export function PanelWidthButton({ isMobile }: { isMobile: boolean }) {
  const isExpanded = useIsExpanded();
  const toggleExpanded = useToggleExpanded();

  if (isMobile) return null;

  const label = isExpanded ? 'Exit full screen' : 'Full screen';

  return (
    <Hint label={label} side="bottom">
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleExpanded}
        aria-label={label}
        className="size-7 shrink-0 active:scale-[0.96]"
      >
        {isExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </Button>
    </Hint>
  );
}
