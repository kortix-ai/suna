'use client';
import { SessionDotMatrix } from '../../../primitives/dot-matrix/session-dot-matrix';
import { TextShimmer } from '../../../primitives/text-shimmer';
import { useBinaryBlob } from '../../../files/runtime/hooks/use-binary-blob';
import { type FileCaption, useFilePreviewStore } from '../../../internal/stores/file-preview-store';
import { ImageFrame } from '../../../files/renderers/image-frame';
import { Button } from '../../../primitives/button';
import { ChatGptConnectionSlot } from '../../models/chatgpt-connection-button';
import { useModelConnectionGate } from '../../models/use-model-connection-gate';
import { sessionPersonalUser } from '../../overrides/provider-pool-draft';
import { useSessionIds } from '../../../providers/session-ids';
import { useUiViewerId } from '../../../providers/ui-provider';
import {
  InTranscriptTurnContext,
  isLocalSandboxFilePath,
  ReadOnlySessionContext,
  TurnLiveContext,
  useToolNavigation,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { useKortixComputerStore } from '../../../internal/stores/kortix-computer-store';
import { cn } from '../../../lib/utils';
import type { ToolProps } from '../shared/types';
import { useLocale, useTranslations } from '../../../i18n';
import { formatImageGenElapsed, imageGenRetryDelay, imageGenView, type ImageGenView, isSandboxNotReadyError } from '@kortix/sdk';
import { type FlatModel, useProjectSession } from '@kortix/sdk/react';
import { ArrowsOutSimpleIcon } from '@phosphor-icons/react';
import { type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

/** The one busy signal over the flat frame. Elapsed time counts from the call's start, so a reload keeps it. */
function BusyLabel({ seed, label, startedAt }: { seed: string; label: string; startedAt?: number | null }) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const timed = startedAt !== undefined;
  useEffect(() => {
    if (!timed) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timed]);
  return (
    <span className="text-muted-foreground flex flex-wrap items-center justify-center gap-2 text-xs">
      <SessionDotMatrix sessionId={seed} size={14} className="shrink-0" />
      <TextShimmer duration={1} spread={2} className="text-xs">
        {label}
      </TextShimmer>
      {timed ? <span className="tabular-nums">{formatImageGenElapsed(now - (startedAt ?? mountedAt))}</span> : null}
    </span>
  );
}

/** "Try again in 2 hours." in the viewer's language. */
function useRetryLine(seconds: number | undefined): string | null {
  const t = useTranslations('imageGen');
  const locale = useLocale();
  if (seconds === undefined) return null;
  const { value, unit } = imageGenRetryDelay(seconds);
  // The Serbian catalog is Latin; Intl's `sr` is Cyrillic.
  const when = new Intl.RelativeTimeFormat(locale === 'sr' ? 'sr-Latn' : locale, { numeric: 'always' }).format(value, unit);
  return t('retry', { when });
}

/** Stable empty list, as `ModelConnectionBar` passes: the card needs only the routing. */
const NO_MODELS: FlatModel[] = [];

/**
 * Opens the project's model settings on Providers: the model picker's connect
 * action (`useModelConnectionGate`). Shown only to a viewer who can change the
 * project's models (`project.model.write`), in a session private to them;
 * hidden outside a project or without the host's provider modal.
 */
function ConnectModelAction() {
  const t = useTranslations('sessionUi.modelGate');
  const { canConnectProvider, canWriteProviders, openConnectProvider, modal } = useModelConnectionGate(NO_MODELS);
  const { projectId, sessionId } = useSessionIds();
  const viewerId = useUiViewerId();
  const session = useProjectSession(projectId ?? '', sessionId ?? '', { enabled: !!projectId && !!sessionId });
  const ownSession = !!viewerId && sessionPersonalUser(session.data) === viewerId;
  if (!canConnectProvider || !canWriteProviders || !ownSession) return null;
  return (
    <>
      {modal}
      <Button size="sm" className="mt-1 active:scale-[0.96]" onClick={() => openConnectProvider('providers')}>
        {t('connectModel')}
      </Button>
    </>
  );
}

/**
 * The fix for a failure a connection can repair, by code, as the session error
 * banner routes it: the member's own ChatGPT login (`ChatGptConnectionSlot`,
 * which applies `chatGptActionApplies`) for the two ChatGPT codes, the
 * project's model settings for `image_model_unavailable`. None in a read-only view.
 */
function ConnectAction({ code }: { code?: string }) {
  const readOnly = useContext(ReadOnlySessionContext);
  if (readOnly) return null;
  if (code === 'provider_not_connected') return <ChatGptConnectionSlot action="connect" className="mt-1" />;
  if (code === 'provider_reauth_required') return <ChatGptConnectionSlot action="reconnect" className="mt-1" />;
  return <ConnectModelAction />;
}

type ImageGenImage = ImageGenView['images'][number];

/** A failure in a quiet plate: the message, the suggestion, the retry wait and `action`. No error reads "Stopped". */
function FailureNote({ error, action, fill = false }: { error: ImageGenView['error']; action?: ReactNode; fill?: boolean }) {
  const t = useTranslations('imageGen');
  const retryLine = useRetryLine(error?.retryAfterSeconds);
  return (
    <div
      className={cn(
        'bg-muted flex flex-col items-start gap-1 rounded-md px-3 py-2.5 text-xs',
        // In a tile: the slot's box, scrolling a long message inside it.
        fill && 'h-full overflow-y-auto',
      )}
    >
      {error ? (
        <>
          <span className="text-foreground">{error.message || t('failed')}</span>
          {error.suggestion ? <span className="text-muted-foreground">{error.suggestion}</span> : null}
          {retryLine ? <span className="text-muted-foreground">{retryLine}</span> : null}
          {action}
        </>
      ) : (
        <span className="text-muted-foreground">{t('stopped')}</span>
      )}
    </div>
  );
}

/**
 * One image, from its generating frame to the file. `busy` is what the frame
 * shows while it generates (the busy line, or the glyph alone in a tile); a
 * frame whose file is still on the way says "Loading image". `fill`: a tile
 * of the bento, which fills its slot and crops the image (`object-cover`).
 * The frame shows no prompt and no toolbar: the whole frame opens the image
 * full screen, uncropped, with its prompt and `model` under it.
 */
function ImageGenFrame({
  image,
  seed,
  busy,
  model,
  fill,
}: {
  image: ImageGenImage;
  seed: string;
  busy: ReactNode;
  model: string | null;
  fill: boolean;
}) {
  const t = useTranslations('imageGen');
  const { enabled: navigationEnabled } = useToolNavigation();
  const filePath = image.imagePath && isLocalSandboxFilePath(image.imagePath) ? image.imagePath : null;
  const { blobUrl, error: rawBlobError } = useBinaryBlob(filePath);
  // A readiness 503 (a parked or booting sandbox) is a wait, not a failure:
  // useBinaryBlob keeps polling while it lasts, so the image lands once the box is up.
  const blobError = rawBlobError && !isSandboxNotReadyError(rawBlobError) ? rawBlobError : null;

  if (image.phase === 'failed') return <FailureNote error={image.error} fill={fill} />;
  if (image.imagePath && !filePath && !image.directUrl) {
    // A path the file API cannot read: name it, as the old card did, instead of loading forever.
    return (
      <div className={cn('bg-muted text-muted-foreground rounded-md px-3 py-2.5 font-mono text-xs break-all', fill && 'h-full overflow-y-auto')}>
        {image.imagePath}
      </div>
    );
  }
  const generating = image.phase === 'generating';
  const src = generating ? null : (image.directUrl ?? blobUrl);
  const caption: FileCaption | undefined = image.prompt ? { text: image.prompt, model } : undefined;
  const openFullScreen =
    filePath && navigationEnabled
      ? () => {
          useFilePreviewStore.getState().openPreview(filePath, undefined, caption);
          // Expand after the open, as the file actions' Full screen does: the
          // detail's own open resets the split, and `isExpanded` outranks it.
          useKortixComputerStore.getState().setIsExpanded(true);
        }
      : undefined;
  return (
    <div className={cn('group relative', fill && 'h-full')}>
      <ImageFrame
        aspectRatio={image.aspectRatio}
        fill={fill}
        src={src}
        alt={image.prompt || t('generating')}
        pending={generating || (!src && !blobError)}
        label={
          generating ? (
            busy
          ) : blobError ? (
            <span className="text-muted-foreground text-xs">{blobError}</span>
          ) : !src ? (
            <BusyLabel seed={seed} label={t('loading')} />
          ) : null
        }
        onOpen={openFullScreen}
      />
      {src && openFullScreen ? (
        // The one hint that the image opens full screen, on hover only; the whole frame is the button.
        <span
          data-image-gen-expand=""
          aria-hidden="true"
          className="bg-popover text-foreground pointer-events-none absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md opacity-0 shadow-xs transition-opacity duration-fast group-focus-within:opacity-100 group-hover:opacity-100"
        >
          <ArrowsOutSimpleIcon className="size-3.5" />
        </span>
      ) : null}
    </div>
  );
}

/** `'3 / 2'` scaled by `num / den` and reduced: the bento rectangle from one tile's ratio. */
function scaledRatio(ratio: string, num: number, den: number): string {
  const [w = 1, h = 1] = ratio.split('/').map((part) => Number(part.trim()) || 1);
  const a = w * num;
  const b = h * den;
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
  const d = gcd(a, b);
  return `${a / d} / ${b / d}`;
}

/**
 * The bento: several images fill one rectangle, the width of the message, its
 * height fixed from the requested ratio, so nothing moves when they land.
 * Tile i keeps slot i. Every tile has the requested ratio `r`:
 * - 2: side by side, one row → the rectangle is `2r`;
 * - 3: tile 0 takes 2/3 of the width and both rows, tiles 1 and 2 stack on
 *   the right third → `1.5r`;
 * - 4: 2×2 → `r`.
 */
const BENTO: Record<number, { grid: string; ratio: [number, number]; first?: string }> = {
  2: { grid: 'grid-cols-2', ratio: [2, 1] },
  3: { grid: 'grid-cols-3 grid-rows-2', ratio: [3, 2], first: 'col-span-2 row-span-2' },
  4: { grid: 'grid-cols-2 grid-rows-2', ratio: [1, 1] },
};

export function ImageGenTool({ call }: ToolProps) {
  const t = useTranslations('imageGen');
  // In a transcript turn, the turn says whether an open call still runs.
  const live = useContext(TurnLiveContext);
  const inTurn = useContext(InTranscriptTurnContext);
  const view = useMemo(() => imageGenView(call, inTurn ? live : undefined), [call, inTurn, live]);
  const edit = view.action === 'edit';
  const solo = view.images.length === 1;
  // One fix per card, even when several frames failed for the same reason.
  const repairable = view.error?.connectModel ? view.error : view.images.find((image) => image.error?.connectModel)?.error;
  const action = repairable ? <ConnectAction code={repairable.code} /> : null;

  // The card carries no prompt and no model (R29): the frames are the content,
  // their status (busy, loading, an error) the only text.
  if (!view.images.length) {
    // The whole call failed or stopped.
    return (
      <div className="w-full max-w-md">
        <FailureNote error={view.error} action={action} />
      </div>
    );
  }

  const busyLine = (
    <BusyLabel
      seed={call.call_id}
      label={solo ? t(edit ? 'editing' : 'generating') : t(edit ? 'editingCount' : 'generatingCount', { count: view.images.length })}
      startedAt={view.startedAt}
    />
  );
  const bento = solo ? null : BENTO[Math.min(view.images.length, 4)]!;
  const frames = view.images.map((image, i) => (
    <ImageGenFrame
      key={i}
      image={image}
      seed={call.call_id}
      model={view.model}
      fill={!solo}
      // The first frame carries the busy line, the one status region; the
      // others show its glyph alone, hidden from assistive tech.
      busy={
        i === 0 ? (
          busyLine
        ) : (
          <span aria-hidden="true" className="text-muted-foreground">
            <SessionDotMatrix sessionId={call.call_id} size={14} />
          </span>
        )
      }
    />
  ));

  return (
    <figure className="flex w-full flex-col gap-2">
      {bento ? (
        <div
          data-image-gen-bento={Math.min(view.images.length, 4)}
          className={cn('grid w-full gap-1', bento.grid)}
          style={{ aspectRatio: scaledRatio(view.aspectRatio, ...bento.ratio) }}
        >
          {frames.slice(0, 4).map((frame, i) => (
            <div key={i} data-image-gen-tile={i} className={cn('min-h-0 min-w-0', i === 0 && bento.first)}>
              {frame}
            </div>
          ))}
        </div>
      ) : (
        frames
      )}
      {/* Failed frames share one fix, under them. */}
      {action ? <div className="flex flex-col items-start">{action}</div> : null}
    </figure>
  );
}
ToolRegistry.register('image-gen', ImageGenTool);
