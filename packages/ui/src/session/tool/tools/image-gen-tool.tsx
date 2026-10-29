'use client';
import { SessionDotMatrix } from '../../../primitives/dot-matrix/session-dot-matrix';
import { TextShimmer } from '../../../primitives/text-shimmer';
import { useSharedImage } from '../../../files/runtime/hooks/use-shared-image';
import { type FileCaption, useFilePreviewStore } from '../../../internal/stores/file-preview-store';
import { ImageFrame, ImageUnavailable } from '../../../files/renderers/image-frame';
import { Button } from '../../../primitives/button';
import { ChatGptConnectionSlot } from '../../models/chatgpt-connection-button';
import { useModelConnectionGate } from '../../models/use-model-connection-gate';
import { sessionPersonalUser } from '../../overrides/provider-pool-draft';
import { useSessionIds } from '../../../providers/session-ids';
import { useUiViewerId } from '../../../providers/ui-provider';
import {
  ImageGenRunsContext,
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
import {
  formatImageGenElapsed,
  imageGenGrid,
  type ImageGenGridTile,
  imageGenRetryDelay,
  imageGenView,
  type ImageGenView,
  sessionLogOpenCall,
} from '@kortix/sdk';
import { type FlatModel, useProjectSession } from '@kortix/sdk/react';
import { ArrowsOutSimpleIcon } from '@phosphor-icons/react';
import { type CSSProperties, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

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
 * The fix for a failure a connection can repair, as the session error banner
 * routes it: the member's own ChatGPT login (`ChatGptConnectionSlot`, which
 * applies `chatGptActionApplies`) when ChatGPT (`openai-codex`) is the provider
 * that failed with `provider_not_connected` or `provider_reauth_required`; the
 * project's model settings for any other provider and for
 * `image_model_unavailable` (R37). None in a read-only view.
 */
function ConnectAction({ code, provider }: { code?: string; provider?: string }) {
  const readOnly = useContext(ReadOnlySessionContext);
  if (readOnly) return null;
  if (provider === 'openai-codex' && code === 'provider_not_connected') return <ChatGptConnectionSlot action="connect" className="mt-1" />;
  if (provider === 'openai-codex' && code === 'provider_reauth_required') return <ChatGptConnectionSlot action="reconnect" className="mt-1" />;
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
  // The page's shared image store: the viewer and a `show` of the same bytes draw this URL too (R38).
  // A sandbox still starting (a waking 503, a runtime URL not pinned yet) is a
  // wait, not a failure: the store reports it as loading and the read keeps
  // polling, so the image lands once the box is up.
  const { url: blobUrl, error: blobError, retry, naturalRatio, onNaturalSize } = useSharedImage(filePath, image.sha256);

  if (image.phase === 'failed' || image.phase === 'stopped') return <FailureNote error={image.error} fill={fill} />;
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
  const caption: FileCaption | undefined = image.prompt
    ? { text: image.prompt, model, ...(image.sha256 && { sha256: image.sha256 }) }
    : undefined;
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
        maxHeight={fill ? undefined : IMAGE_MAX_HEIGHT}
        openLabel={image.prompt ? t('openFullScreenPrompt', { prompt: image.prompt }) : t('openFullScreen')}
        src={src}
        alt={image.prompt || t('generating')}
        pending={generating || (!src && !blobError)}
        label={
          generating ? (
            busy
          ) : blobError ? (
            <ImageUnavailable onRetry={retry} />
          ) : !src ? (
            <BusyLabel seed={seed} label={t('loading')} />
          ) : null
        }
        onOpen={openFullScreen}
        naturalRatio={naturalRatio}
        onNaturalSize={onNaturalSize}
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

/**
 * The tallest a lone image or the bento may be (R33). The box narrows to
 * keep its ratio, so it never crops more and never letterboxes.
 */
const IMAGE_MAX_HEIGHT = '60vh';

/** `'3 / 2'` → `1.5`; anything unreadable → `1`. */
function ratioValue(ratio: string): number {
  const [w, h] = ratio.split('/').map((part) => Number(part.trim()));
  return w && h ? w / h : 1;
}

/**
 * The bento: several images fill one rectangle, the width of the message up
 * to `IMAGE_MAX_HEIGHT` tall, its ratio fixed from the requested one, so
 * nothing moves when they land.
 * Tile i keeps slot i. Every tile has the requested ratio `r`:
 * - 2: side by side, one row → the rectangle is `2r`;
 * - 3: tile 0 takes 2/3 of the width and both rows, tiles 1 and 2 stack on
 *   the right third → `1.5r`;
 * - 4: 2×2 → `r`.
 */
const BENTO: Record<number, { grid: string; scale: number; first?: string }> = {
  // Explicit rows: each is minmax(0, 1fr), so a loaded image never stretches one.
  2: { grid: 'grid-cols-2 grid-rows-1', scale: 2 },
  3: { grid: 'grid-cols-3 grid-rows-2', scale: 1.5, first: 'col-span-2 row-span-2' },
  4: { grid: 'grid-cols-2 grid-rows-2', scale: 1 },
};

/** `min(100%, …)`: the widest a rectangle of ratio `rect` may be under the height cap. */
const cappedWidth = (rect: number) => `min(100%, calc(${IMAGE_MAX_HEIGHT} * ${rect}))`;

/**
 * Five or more images (R38): ONE grid of six columns whose rows are the
 * bento patterns (`imageGenGrid().rows`: 5 = 3+2, 8 = 4+4, …). Every tile sits
 * in the same grid, placed by line numbers, so a tile is never re-parented.
 *
 * The grid is as wide as its tallest row allows under the cap (`width`), and
 * each row is exactly `width / rects[k]` tall (`rects[k]` = its tile ratio ×
 * the pattern's scale), so no row passes `IMAGE_MAX_HEIGHT`. Track heights are
 * lengths, read from the figure's inline size (`cqw`): the grid is the sum of
 * its rows and the gaps between them, with no aspect ratio of its own. (Flex
 * rows under an aspect ratio left an empty band whenever their `fr` factors
 * summed below 1, e.g. 16:9 tiles.) A two-track row subtracts the gap between
 * its tracks, so a large tile spanning both is the row's height.
 */
function gridPlacement(rows: number[], rects: number[]) {
  const width = `min(100cqw, ${IMAGE_MAX_HEIGHT} * ${Math.min(...rects)})`;
  const tracks: string[] = [];
  const places: CSSProperties[] = [];
  rows.forEach((count, row) => {
    const track = tracks.length + 1;
    const height = `${width} / ${rects[row]}`;
    if (count === 2) tracks.push(`calc(${height})`);
    else tracks.push(`calc((${height} - var(--spacing)) / 2)`, `calc((${height} - var(--spacing)) / 2)`);
    for (let i = 0; i < count; i++) {
      if (count === 2) places.push({ gridColumn: `${1 + 3 * i} / span 3`, gridRow: `${track}` });
      else if (count === 4) places.push({ gridColumn: `${1 + 3 * (i % 2)} / span 3`, gridRow: `${track + Math.floor(i / 2)}` });
      else if (i === 0) places.push({ gridColumn: '1 / span 4', gridRow: `${track} / span 2` });
      else places.push({ gridColumn: '5 / span 2', gridRow: `${track + i - 1}` });
    }
  });
  return { style: { gridTemplateRows: tracks.join(' '), width }, places };
}

export function ImageGenTool({ call }: ToolProps) {
  const t = useTranslations('imageGen');
  // In a transcript turn, the turn says whether an open call still runs.
  const live = useContext(TurnLiveContext);
  const inTurn = useContext(InTranscriptTurnContext);
  // Consecutive image_gen calls of a turn draw as one grid, here, at the first (R38).
  const run = useContext(ImageGenRunsContext).get(call.id);
  const views = useMemo(
    () => (run ? run.map(sessionLogOpenCall) : [call]).map((one) => imageGenView(one, inTurn ? live : undefined)),
    [run, call, inTurn, live],
  );
  const grid = useMemo(() => imageGenGrid(views), [views]);
  const view = views[0]!;
  const solo = views.length === 1 && view.images.length === 1;
  // One fix per card, even when several frames failed for the same reason.
  const repairable =
    views.find((one) => one.error?.connectModel)?.error ??
    views.flatMap((one) => one.images).find((image) => image.error?.connectModel)?.error;
  const action = repairable ? <ConnectAction code={repairable.code} provider={repairable.provider} /> : null;

  // The card carries no prompt and no model (R29): the frames are the content,
  // their status (busy, loading, an error) the only text.
  if (views.length === 1 && !view.images.length) {
    // The whole call failed or stopped.
    return (
      <div className="w-full max-w-md">
        <FailureNote error={view.error} action={action} />
      </div>
    );
  }

  const callIds = (run ?? [call]).map((one) => one.call_id);
  const frame = ({ image, call: at, first }: ImageGenGridTile) => {
    const callView = views[at]!;
    const edit = callView.action === 'edit';
    const seed = callIds[at]!;
    const several = callView.images.length > 1;
    return (
      <ImageGenFrame
        image={image}
        seed={seed}
        model={callView.model}
        fill={!solo}
        // Each call's first frame carries its busy line, the one status region
        // per call; the others show its glyph alone, hidden from assistive tech.
        busy={
          first ? (
            <BusyLabel
              seed={seed}
              label={several ? t(edit ? 'editingCount' : 'generatingCount', { count: callView.images.length }) : t(edit ? 'editing' : 'generating')}
              startedAt={callView.startedAt}
            />
          ) : (
            <span aria-hidden="true" className="text-muted-foreground">
              <SessionDotMatrix sessionId={seed} size={14} />
            </span>
          )
        }
      />
    );
  };
  // A tile is keyed by its call and place in it: it keeps its frame (and its
  // loaded image) while the run grows.
  // A call's tiles are contiguous, so its place is the distance to its first tile.
  const tileKey = (tile: ImageGenGridTile, i: number) => `${callIds[tile.call]}:${i - grid.tiles.findIndex((other) => other.call === tile.call)}`;

  if (solo) {
    return (
      <figure className="flex w-full flex-col gap-2">
        {frame(grid.tiles[0]!)}
        {action ? <div className="flex flex-col items-start">{action}</div> : null}
      </figure>
    );
  }

  const count = grid.tiles.length;
  const bento = grid.rows.length === 1 ? BENTO[count]! : null;
  const rowRects = grid.rows.map((size, row) => {
    const firstTile = grid.tiles[grid.rows.slice(0, row).reduce((sum, n) => sum + n, 0)]!;
    return ratioValue(views[firstTile.call]!.aspectRatio) * BENTO[size]!.scale;
  });
  const placed = bento ? null : gridPlacement(grid.rows, rowRects);

  return (
    // An inline-size container: the merged grid sizes its rows from its width (`cqw`).
    <figure className={cn('flex w-full flex-col gap-2', !bento && '@container')}>
      <div
        {...(bento ? { 'data-image-gen-bento': count } : { 'data-image-gen-grid': grid.rows.join('+') })}
        className={cn('grid min-h-0 w-full gap-1', bento ? bento.grid : 'grid-cols-6')}
        style={placed ? placed.style : { aspectRatio: rowRects[0], width: cappedWidth(rowRects[0]!) }}
      >
        {grid.tiles.map((tile, i) => (
          <div
            key={tileKey(tile, i)}
            data-image-gen-tile={i}
            className={cn('min-h-0 min-w-0', bento && i === 0 && bento.first)}
            style={placed?.places[i]}
          >
            {frame(tile)}
          </div>
        ))}
      </div>
      {/* Failed frames share one fix, under them. */}
      {action ? <div className="flex flex-col items-start">{action}</div> : null}
    </figure>
  );
}
ToolRegistry.register('image-gen', ImageGenTool);
