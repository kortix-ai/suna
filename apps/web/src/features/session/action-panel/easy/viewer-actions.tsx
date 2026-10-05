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
 * ─── The address pill ──────────────────────────────────────────────────────
 *
 * The header is one filled pill that names the output, plus the panel's own
 * controls outside it:
 *
 *     ( 📄 src / pages / Home.tsx        ↻  ⧉  🔗 )   [⬇]   [⤢]   [✕]
 *     ←  →  ( 🌐 http://localhost:5000/      ↻  🔗 )   [↗]   [⤢]   [✕]
 *
 * The actions that act on the thing the pill names — reload it, copy it, copy
 * a link to it — sit inside the pill, at its trailing edge. Download, open in
 * a new tab, full screen and close sit outside: they take the output out of
 * the panel or act on the panel itself.
 *
 * Inside the pill every action is an icon with a tooltip. Copy and Copy link
 * confirm in place: the glyph flips to a check for 2s, so no toast is needed.
 * There is no menu: each action is one click, and a surface simply omits the
 * actions it cannot do.
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { ViewerDownloadButton } from '@/features/file-renderers/shared/viewer-download-button';
import { downloadFile } from '@/features/files/api/runtime-files';
import { Copy } from '@/features/icon/icons/copy';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { usePublicShareLink } from '@/hooks/use-public-share-link';
import {
  findLiveSharesFor,
  publicShareUrl,
  useRevokePublicShare,
  useSessionPublicShares,
} from '@/hooks/use-session-public-shares';
import { track } from '@/lib/track';
import { cn } from '@/lib/utils';
import { useIsExpanded, useToggleExpanded } from '@/stores/kortix-computer-store';
import type { CreateSessionPublicShareInput } from '@kortix/sdk';
import {
  ArrowClockwiseIcon,
  LinkSimpleIcon,
  ArrowsOutSimpleIcon as Maximize2,
  ArrowsInSimpleIcon as Minimize2,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';

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
  /** Tooltip and screen-reader label, e.g. "Copy file contents". */
  ariaLabel: string;
}

/** The bytes behind this output, for the Download button. */
export interface ViewerDownload {
  path: string;
  fileName: string;
}

/** Size and shape of every icon button inside the address pill. */
export const PILL_ICON_BUTTON = 'size-6 shrink-0 rounded-sm active:scale-[0.96]';

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
 * The folders above a file, as the pill shows them: `/workspace/src/pages/Home.tsx`
 * → `['src', 'pages']`. The sandbox root is implied, so it is never shown.
 */
export function pathCrumbs(path: string | undefined): string[] {
  if (!path) return [];
  const parts = path.replace(/^\/workspace(?=\/|$)/, '').split('/').filter(Boolean);
  return parts.slice(0, -1);
}

/**
 * The filled pill a file viewer's header is built around: the file's icon, its
 * folders and its name, with the file's own actions at the trailing edge.
 * Folders truncate before the name does — the name is what tells two open
 * files apart.
 */
export function ViewerPathPill({
  icon,
  path,
  fileName,
  children,
}: {
  icon: React.ReactNode;
  path?: string;
  fileName: string;
  /** The file's actions — `RefreshButton`, `ViewerActions`. */
  children?: React.ReactNode;
}) {
  const crumbs = pathCrumbs(path);
  return (
    <span className="bg-muted flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md px-1">
      <span className="flex size-6 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm" title={path}>
        {crumbs.length > 0 && (
          <span className="text-muted-foreground min-w-0 shrink-[3] truncate">
            {crumbs.join(' / ')} /
          </span>
        )}
        <span className="text-foreground min-w-0 truncate font-medium">{fileName}</span>
      </span>
      {children && <span className="flex shrink-0 items-center gap-0.5">{children}</span>}
    </span>
  );
}

/**
 * `true` for 2s after `flash()` — the window a copy button shows its check.
 */
function useFlash() {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const flash = useCallback(() => {
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), 2000);
  }, []);
  return [on, flash] as const;
}

/** One icon button inside the pill: a glyph that flips to a check once done. */
function PillIconButton({
  label,
  done,
  busy = false,
  onClick,
  children,
}: {
  label: string;
  done: boolean;
  busy?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Hint label={done ? 'Copied' : label} side="bottom">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onClick}
        disabled={busy}
        aria-label={done ? 'Copied' : label}
        aria-busy={busy}
        className={cn(PILL_ICON_BUTTON, 'disabled:opacity-100')}
      >
        {busy ? (
          <Loading className="text-muted-foreground size-3.5 shrink-0 motion-reduce:animate-none" />
        ) : done ? (
          <SolidCheckIcon className="size-3.5" />
        ) : (
          children
        )}
      </Button>
    </Hint>
  );
}

/**
 * `Copy` and `Copy link` as icons inside the address pill.
 *
 * Self-gating: hand it whatever the surface has. `Copy` needs content a
 * clipboard can hold; `Copy link` needs a share context and a share input.
 * With neither it renders nothing.
 */
export function ViewerActions({
  copy,
  shareContext,
  shareInput,
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
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const share = usePublicShareLink({
    projectId: shareContext?.projectId,
    sessionId: shareContext?.sessionId,
    input: shareInput,
  });
  const [copied, flashCopied] = useFlash();

  const runCopy = useCallback(async () => {
    if (!copy) return;
    try {
      await copy.run();
    } catch {
      // Clipboard denied — the button simply doesn't confirm.
      return;
    }
    flashCopied();
  }, [copy, flashCopied]);

  if (!copy && !share.canShare) return null;

  return (
    <>
      {copy && (
        <PillIconButton label={copy.ariaLabel} done={copied} onClick={() => void runCopy()}>
          <Copy className="size-3.5" />
        </PillIconButton>
      )}
      {share.canShare && (
        <PublicLinkPopover share={share} shareContext={shareContext} shareInput={shareInput} />
      )}
    </>
  );
}

const EXPIRY_OPTIONS = [
  { id: 'never', label: 'Never', days: null },
  { id: '1d', label: '1 day', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
] as const;
type ExpiryId = (typeof EXPIRY_OPTIONS)[number]['id'];

function expiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return 'Never expires';
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime())
    ? 'Never expires'
    : `Expires ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/**
 * `Copy link` and everything about the link behind it, in one popover.
 *
 * A file or app mint always makes a NEW public token (only transcripts are
 * reused server-side), so the popover reads the session's live shares first:
 *
 *   - a live link for this exact file or port → show it, copy it, see when it
 *     expires, revoke it;
 *   - none → confirm creating one, with an expiry. A public link needs no
 *     sign-in, so it is a decision, not a copy.
 *
 * After a create the share list refetches and the open popover turns into the
 * first state — the link it just made.
 */
function PublicLinkPopover({
  share,
  shareContext,
  shareInput,
}: {
  share: ReturnType<typeof usePublicShareLink>;
  shareContext?: ShareContext;
  shareInput: CreateSessionPublicShareInput | null;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryId>('7d');
  const [copied, flashCopied] = useFlash();
  const { shares } = useSessionPublicShares(shareContext?.projectId, shareContext?.sessionId);
  const { revokeAll, isRevoking } = useRevokePublicShare(
    shareContext?.projectId,
    shareContext?.sessionId,
  );

  const liveShares = findLiveSharesFor(shares, shareInput);
  const live = liveShares[0] ?? null;
  const url = live ? publicShareUrl(live.public_path) : null;

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      return;
    }
    track('deliverable_link_copied');
    flashCopied();
  };

  const create = () => {
    const days = EXPIRY_OPTIONS.find((o) => o.id === expiry)?.days ?? null;
    share.confirmation.onConfirm(
      days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
    );
  };

  return (
    <Popover open={open} onOpenChange={(next) => !share.isPending && setOpen(next)}>
      <PopoverAnchor asChild>
        <span className="flex">
          <PillIconButton
            label={tI18nComplete.raw('textdbf362d4f210')}
            done={copied || share.copied}
            busy={share.isPending}
            onClick={() => setOpen((o) => !o)}
          >
            <LinkSimpleIcon className="size-3.5" />
          </PillIconButton>
        </span>
      </PopoverAnchor>
      <PopoverContent align="end" className="flex flex-col gap-3">
        {live && url ? (
          <>
            <div className="flex flex-col gap-1">
              <p className="text-foreground text-sm font-medium">Public link</p>
              <p className="text-muted-foreground text-xs">
                Anyone with the link can view it without signing in. {expiryLabel(live.expires_at)}.
                {liveShares.length > 1 &&
                  ` ${liveShares.length} links point here; revoking turns them all off.`}
              </p>
            </div>
            <div className="bg-muted flex h-8 items-center gap-1 rounded-md pr-1 pl-2">
              <span className="text-foreground min-w-0 flex-1 truncate text-xs" title={url}>
                {url}
              </span>
              <PillIconButton label="Copy" done={copied} onClick={() => void copyUrl()}>
                <Copy className="size-3.5" />
              </PillIconButton>
            </div>
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="toolbar"
                disabled={isRevoking}
                onClick={() => revokeAll(liveShares.map((s) => s.share_id))}
                className="text-destructive"
              >
                {isRevoking && (
                  <Loading className="size-3.5 shrink-0 motion-reduce:animate-none" />
                )}
                {liveShares.length > 1 ? `Revoke ${liveShares.length} links` : 'Revoke link'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <p className="text-foreground text-sm font-medium">
                {tHardcodedUi.raw('publicShareConfirm.title')}
              </p>
              <p className="text-muted-foreground text-xs">
                Anyone with the link can view this without signing in.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-muted-foreground text-xs">Expires after</p>
              <div className="bg-muted flex rounded-md p-0.5" role="radiogroup">
                {EXPIRY_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={expiry === option.id}
                    onClick={() => setExpiry(option.id)}
                    className={cn(
                      'h-6 flex-1 rounded-sm text-xs transition-colors',
                      expiry === option.id
                        ? 'bg-background text-foreground shadow-xs'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="toolbar"
                disabled={share.isPending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button size="toolbar" disabled={share.isPending} onClick={create}>
                {share.isPending && <Loading className="size-3.5 shrink-0 motion-reduce:animate-none" />}
                {tHardcodedUi.raw('publicShareConfirm.confirm')}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Download, outside the pill: it takes the bytes out of the panel.
 *
 * Download fetches the file's real bytes before the browser's save dialog can
 * appear, so on anything bigger than a note there is a real wait. Without a
 * pending state the control looks broken and gets invoked again — which starts
 * a second fetch. The spinner renders on the button itself.
 */
export function ViewerDownloadAction({ download }: { download?: ViewerDownload }) {
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  if (!download) return null;

  const run = async () => {
    if (pending) return;
    setPending(true);
    try {
      await downloadFile(download.path, download.fileName);
      track('deliverable_downloaded', { scope: 'one' });
    } catch {
      // The browser reports its own failure; the control just needs to recover.
    } finally {
      if (alive.current) setPending(false);
    }
  };

  // Ghost, like full screen and close beside it: outside the pill every
  // control carries the same weight.
  return <ViewerDownloadButton variant="ghost" onDownload={() => void run()} pending={pending} />;
}


/**
 * Re-read the open file from the sandbox now.
 *
 * The safety net under the automatic refresh: the agent's turn end already
 * refetches every open file, so this is for edits the turn end cannot see — a
 * terminal, another tab, a stylesheet an HTML page loads. It acts on the file,
 * so it sits inside the address pill with the file's other actions. The
 * glyph gives way to the product's one spinner while the read is in flight.
 */
export function RefreshButton({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const label = tI18nComplete.raw('text0e9161011702');

  return (
    <Hint label={label} side="bottom">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label={label}
        aria-busy={refreshing}
        className={PILL_ICON_BUTTON}
      >
        {refreshing ? (
          <Loading className="text-muted-foreground size-3.5 shrink-0 motion-reduce:animate-none" />
        ) : (
          <ArrowClockwiseIcon className="size-3.5" />
        )}
      </Button>
    </Hint>
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
