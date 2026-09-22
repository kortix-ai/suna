'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * Toolbar controls shared by the detail layer's three viewers — `FileViewer`
 * (text), `PreviewShell` (everything else) and `AppPreview` (a running port).
 *
 * All three are deliberately identical so the actions never move between one
 * output and the next. That contract only holds if they render the SAME
 * controls, not three copies that drift apart the first time any is touched.
 *
 * ─── Why one split button plus one Download button ────────────────────────
 *
 * This bar used to be six flat icon peers — ask for changes, copy, open in a
 * new tab, copy link, download, full screen — plus close. Seven glyphs with no
 * hierarchy: every action shouted at the same volume, so none of them read as
 * *the* action, and three of them ("copy" vs "copy link" vs "open in a tab")
 * were mutually indistinguishable at 14px.
 *
 * Now there is one labelled control with a caret, then Refresh and Download:
 *
 *     [  Copy  |ᵛ]   [↻]   [⬇]   [⤢]   [✕]
 *
 * `Copy` says in words what it does, so it needs no tooltip, no icon, and
 * cannot be confused with its neighbours. The word alone also carries the
 * confirmation — it flips to `Copied`. `Copy link` is its fallback, and when
 * both exist it waits behind the caret.
 *
 * Download is never behind the caret. It is the action people reach for most
 * after reading a file, so it is always a visible, single-click icon button —
 * the same `ViewerDownloadButton` every file renderer's own toolbar uses, so
 * there is exactly one Download control per viewer. Refresh sits beside it for
 * the same reason: an agent rewrites files while they are open, and re-reading
 * one must not mean closing the viewer. Full screen and close stay
 * outside too — they act on the panel, not on the output.
 *
 * ─── The one rule that decides the split button ────────────────────────────
 *
 * The primary is the first of these the surface can actually do:
 *
 *   1. `Copy`      — the output's own content (a file's text, an image's pixels)
 *   2. `Copy link` — a public, view-only link
 *
 * and the menu holds the one it did NOT take, plus any extra menu items. A
 * split button with no menu items drops its caret; a surface with neither
 * action shows no split button at all. `planViewerActions` is that rule,
 * written once and unit-tested.
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
import { ViewerDownloadButton } from '@/features/file-renderers/shared/viewer-download-button';
import { ViewerRefreshButton } from '@/features/file-renderers/shared/viewer-refresh-button';
import { downloadFile } from '@/features/files/api/runtime-files';
import { usePublicShareLink } from '@/hooks/use-public-share-link';
import { track } from '@/lib/track';
import { cn } from '@/lib/utils';
import { useIsExpanded, useToggleExpanded } from '@/stores/kortix-computer-store';
import type { CreateSessionPublicShareInput } from '@kortix/sdk';
import {
  CaretDownIcon,
  DotsThreeIcon,
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

/** The bytes behind this output, for the Download button. */
export interface ViewerDownload {
  path: string;
  fileName: string;
}

/**
 * Download fetches the file's real bytes before the browser's save dialog can
 * appear, so on anything bigger than a note there is a real wait. Without a
 * pending state the control looks broken and gets invoked again — which starts
 * a second fetch. The spinner renders on the Download button itself.
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

export type ViewerPrimaryKind = 'copy' | 'link';
export type ViewerMenuItemKind = 'link' | 'extra';

export interface ViewerActionsPlan {
  /** The split button's labelled half, or null when there is no split button. */
  primary: ViewerPrimaryKind | null;
  /** What sits behind the caret, in order. Empty means no caret. */
  menu: ViewerMenuItemKind[];
  /** Refresh is its own visible button — never a menu item. */
  refresh: boolean;
  /** Download is its own visible button — never a menu item. */
  download: boolean;
}

/**
 * The layout rule from this file's header, as a pure function so it can be
 * pinned by tests without rendering a menu (Radix only mounts menu content
 * once it is open, so static markup cannot show what a menu holds).
 */
export function planViewerActions({
  canCopy,
  canCopyLink,
  canRefresh,
  canDownload,
  hasExtraMenuItems,
}: {
  canCopy: boolean;
  canCopyLink: boolean;
  canRefresh: boolean;
  canDownload: boolean;
  hasExtraMenuItems: boolean;
}): ViewerActionsPlan {
  const primary: ViewerPrimaryKind | null = canCopy ? 'copy' : canCopyLink ? 'link' : null;
  const menu: ViewerMenuItemKind[] = [];
  if (canCopyLink && primary !== 'link') menu.push('link');
  if (hasExtraMenuItems) menu.push('extra');
  return { primary, menu, refresh: canRefresh, download: canDownload };
}

/**
 * `Copy` / `Copy link` as one split button, and Download as a visible button
 * beside it.
 *
 * Self-gating: hand it whatever the surface has and it works out the shape. A
 * split button with exactly one action renders a lone button and no caret — a
 * menu holding a single item is a click for nothing.
 */
export function ViewerActions({
  copy,
  shareContext,
  shareInput,
  download,
  refresh,
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
  /** Re-read the file in place. Rendered as a visible Refresh button beside
   *  Download. Omit where the surface has its own reload — a running app. */
  refresh?: () => Promise<unknown>;
  /** Rendered at the end of the menu. `AppPreview` puts "Open in a new tab"
   *  here: it is the only surface where a real browser tab shows something the
   *  panel cannot. */
  extraMenuItems?: React.ReactNode;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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

  const plan = planViewerActions({
    canCopy: Boolean(copy),
    canCopyLink: share.canShare,
    canRefresh: Boolean(refresh),
    canDownload: Boolean(download),
    hasExtraMenuItems: Boolean(extraMenuItems),
  });
  const { primary } = plan;

  const menu = plan.menu.map((item) =>
    item === 'link' ? (
      <DropdownMenuItem
        key="link"
        disabled={share.isPending}
        onSelect={() => {
          track('deliverable_link_copied');
          share.copyLink();
        }}
      >
        <LinkSimpleIcon />
        {tI18nComplete.raw('textdbf362d4f210')}
      </DropdownMenuItem>
    ) : (
      <Fragment key="extra">{extraMenuItems}</Fragment>
    ),
  );

  // Refresh and Download are always their own visible buttons, in that order,
  // right of the split button. Never menu items.
  const fileButtons =
    plan.refresh || plan.download ? (
      <>
        {plan.refresh && refresh && <ViewerRefreshButton onRefresh={refresh} />}
        {plan.download && (
          <ViewerDownloadButton onDownload={() => void dl.run()} pending={dl.pending} />
        )}
      </>
    ) : null;

  // No split button on two kinds of surface: a file in a session with no
  // project context (nothing to copy, no link to mint — Download alone), and
  // an app in such a session, where "Open in a new tab" still works. A lone
  // menu keeps that reachable rather than blanking the toolbar.
  if (!primary) {
    if (menu.length === 0 && !fileButtons) return null;
    return (
      <span className={cn('flex shrink-0 items-center gap-1', className)}>
        {menu.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={tI18nComplete.raw('textf8d46c2570e7')}
                className="shrink-0 active:scale-[0.96]"
              >
                <DotsThreeIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              {menu}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {fileButtons}
      </span>
    );
  }

  // `Copy link` reports its mint in exactly one place: on the primary when it
  // IS the primary, on the caret when it lives in the menu (by which point the
  // menu has closed and the caret is the only thing left on screen).
  // Download reports on its own button.
  const primaryBusy = primary === 'link' && share.isPending;
  const menuBusy = primary !== 'link' && share.isPending;

  // ─── The primary is a word, and only a word. ───────────────────────────
  // No icon: an icon beside a label that already says "Copy" is decoration,
  // and it was decoration that made this toolbar unreadable in the first
  // place. That leaves the label itself to carry the confirmation — it flips
  // to "Copied", which is louder and clearer than a 14px check ever was, and
  // reads to a screen reader without a live region.
  //
  // The group is right-anchored inside a `justify-between` row, so the extra
  // two characters extend the button's LEFT edge; the caret, Download, full
  // screen and close do not move.
  const justDone = primary === 'copy' ? copied : share.copied;
  const primaryLabel = justDone ? 'Copied' : primary === 'copy' ? 'Copy' : 'Copy link';

  const onPrimary = () => {
    if (primary === 'copy') return void runCopy();
    track('deliverable_link_copied');
    return share.copyLink();
  };

  const primaryButton = (
    <Button
      variant="outline"
      size="toolbar"
      onClick={onPrimary}
      disabled={primaryBusy}
      aria-label={justDone || primary !== 'copy' ? primaryLabel : copy!.ariaLabel}
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
  const split =
    menu.length === 0 ? (
      primaryButton
    ) : (
      <ButtonGroup className="shrink-0">
        {primaryButton}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              aria-label={tI18nComplete.raw('textf8d46c2570e7')}
              className="active:scale-[0.96]"
            >
              {/* The caret carries the pending state for a link minted from
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

  return (
    <span className={cn('flex shrink-0 items-center gap-1', className)}>
      {split}
      {fileButtons}
    </span>
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
