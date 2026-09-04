'use client';

import Loading from '@/components/ui/loading';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { prefersPreviewLink } from '@/features/session/preview-url-fallback';
import {
  isShowContentUnavailable,
  isShowPayloadEmpty,
  type ShowLoadStatus,
} from '@/features/session/show-availability';
import {
  InlineServicePreview,
  BoundActivateContext,
  partInput,
  ServicePreviewActions,
  type ServicePreviewState,
  ToolRunningContext,
  ToolSurfaceContext,
  useToolNavigation,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import {
  buildHtmlStaticUrl,
  ServicePreviewViewport,
  SHOW_HTML_EXT_RE,
  ShowCarousel,
  ShowCarouselItem,
  ShowContentRenderer,
  showDomain,
  ShowFileActions,
  showFileTypeIcon,
  useServicePreview,
} from '@/features/session/tool/shared/show-helpers';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { safeHttpUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';
import { isAppRouteUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { GlobeIcon as Globe } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

// The header owns a single preview state for the active item; the carousel gets it
// through context so its viewport and the header controls drive the same iframe.
const ActiveServicePreviewContext = createContext<ServicePreviewState | null>(null);

// ShowCarousel only renders the active item, so the context preview (derived from
// the same active item) is always the right one when this is asked to render.
function CarouselServicePreview({ url, label }: { url: string; label?: string }) {
  const preview = useContext(ActiveServicePreviewContext);
  if (preview) return <ServicePreviewViewport preview={preview} />;
  return <InlineServicePreview url={url} label={label} />;
}

export function ShowTool({ part, sessionId }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const running = useContext(ToolRunningContext);

  const fill = useContext(ToolSurfaceContext) === 'panel';
  const activate = useContext(BoundActivateContext);
  const { enabled: navigationEnabled } = useToolNavigation();

  const title = (input.title as string) || '';
  const description = (input.description as string) || '';
  const type = (input.type as string) || '';
  const path = (input.path as string) || '';
  const url = (input.url as string) || '';
  const content = (input.content as string) || '';
  const aspectRatio = (input.aspect_ratio as string) || '';
  const language = (input.language as string) || '';

  const items = useMemo<ShowCarouselItem[] | null>(() => {
    const raw = input.items;
    if (!raw) return null;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
    return null;
  }, [input.items]);

  const isCarousel = !!items && items.length > 0;

  const [carouselIndex, setCarouselIndex] = useState(0);
  const currentItem = isCarousel ? items![carouselIndex] || items![0] : null;

  const [contentStatus, setContentStatus] = useState<ShowLoadStatus>('loading');

  const activeType = isCarousel ? currentItem?.type || '' : type;
  const activeUrl = isCarousel ? currentItem?.url || '' : url;
  const activePath = isCarousel ? currentItem?.path || '' : path;
  const activeTitle = isCarousel ? currentItem?.title || '' : title;

  // Resolving the preview target parses `activeUrl` as a URL twice
  // (`parseLocalhostUrl`, then `isAppRouteUrl`) and scans `activePath` with the
  // extension regex. None of it depends on render state, so uncached it ran on
  // every frame of every `show` row still mounted in the transcript.
  const resolvedPreviewUrl = useMemo(() => {
    const hasLocalhostUrl = !!parseLocalhostUrl(activeUrl) && !isAppRouteUrl(activeUrl);
    if (hasLocalhostUrl) return activeUrl;
    const isHtmlFilePath =
      !!activePath &&
      SHOW_HTML_EXT_RE.test(activePath) &&
      (activeType === 'file' || activeType === 'html');
    return isHtmlFilePath ? buildHtmlStaticUrl(activePath) : '';
  }, [activeUrl, activePath, activeType]);
  const isWebsitePreview = !!resolvedPreviewUrl;

  /**
   * A file-backed show gets its actions INSIDE the renderer's own header —
   * `ShowContentRenderer` routes them to each viewer's native toolbar slot, or
   * supplies the row itself for the viewers that ship none. There is never a
   * second header stacked above the viewer.
   *
   * On the inline (chat) surface the card header owns the toolbar, so these
   * stay out of the renderer there and only land in the header row.
   */
  const fileActions =
    !isWebsitePreview && activePath ? (
      <ShowFileActions path={activePath} inPanel={fill} />
    ) : undefined;
  const contentActions =
    !isCarousel && !isWebsitePreview && !activePath && content && activate && navigationEnabled ? (
      <Hint label="Open in the panel" side="top">
        <Button type="button" onClick={activate} size="xs" className="active:scale-[0.96]">
          Preview
        </Button>
      </Hint>
    ) : undefined;
  const preview = useServicePreview(
    resolvedPreviewUrl,
    activeTitle || title || description || undefined,
    sessionId,
  );

  // Precomputed up front (pure derivations over state already resolved above)
  // so both the loading body and the main body can feed the same safe title
  // into the inline header — mirrors the `showLabel`-style precedence
  // (title > description/domain fallback > generic label), never the raw
  // path/URL. `showDomain` echoes its input verbatim when URL parsing fails,
  // so the type==='url' fallback is gated through `safeHttpUrl` first (the
  // same pattern show-content-renderer.tsx uses): a relative or non-http(s)
  // value never reaches the always-visible subtitle — it degrades to 'Link'.
  const safeSubtitleUrl = useMemo(() => (type === 'url' ? safeHttpUrl(url) : null), [type, url]);
  const subtitleDomain = useMemo(
    () => (safeSubtitleUrl ? showDomain(safeSubtitleUrl) : ''),
    [safeSubtitleUrl],
  );
  const displayTitle = isCarousel
    ? title || `${items!.length} items`
    : title || (type === 'error' ? 'Error' : type === 'url' ? subtitleDomain || 'Link' : 'Output');

  const headerIcon = isCarousel ? currentItem?.type || 'image' : isWebsitePreview ? 'url' : type;

  // Inline card header owns the toolbar. Panel keeps the actions inside the
  // renderer / website header as before.
  const inlineToolbar = isWebsitePreview ? (
    <ServicePreviewActions preview={preview} />
  ) : (
    fileActions || contentActions
  );

  // `prefersPreviewLink` parses the candidate URL; it is an argument to the
  // availability gate below, so it was re-parsed on every render.
  const previewIsLinkOnly = useMemo(
    () => prefersPreviewLink(preview.previewUrl),
    [preview.previewUrl],
  );

  // Nothing was handed over: no items, no path, no url, no content — only
  // metadata about an artifact that never arrived. Every branch of
  // `ShowContentRenderer` is guarded on one of those fields, so the cascade
  // falls through to a fallback with all four sub-conditions false and the card
  // renders as a header over an empty box. Draw nothing instead.
  //
  // The chat transcript drops the part one level higher (`isEmptyShowPart`, so
  // no blank row or rail is left behind); this is the same verdict applied at
  // the renderer, which is what the Action Panel and /debug/tools reach.
  //
  // `running` is the guard, not the status: a call still streaming its
  // arguments has an empty input because the input has not arrived yet, and its
  // header carries the spinner that says so.
  const hasNothingToShow = useMemo(
    () => isShowPayloadEmpty({ items, path, url, content }),
    [items, path, url, content],
  );
  if (!running && hasNothingToShow) return null;

  let body: ReactNode;

  if (running && !type && !items) {
    // Only the panel surface still needs the bespoke loading card. Inline, the
    // card header carries the running spinner.
    body = fill ? (
      <div className="bg-card flex h-full items-center justify-center overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4">
          <Loading className="text-muted-foreground size-4" />
          <TextShimmer duration={1} spread={2} className="text-sm">
            {tHardcodedUi.raw('componentsSessionToolRenderers.line4935JsxTextPreparingOutput')}
          </TextShimmer>
        </div>
      </div>
    ) : null;
  } else if (
    isShowContentUnavailable({
      running,
      isCarousel,
      contentStatus,
      isWebsitePreview,
      previewHasError: preview.hasError,
      previewIsLinkOnly,
    })
  ) {
    // The artifact didn't load (renamed/deleted file, dead preview). Never
    // vanish — an invisible `show` reads as "the tool never ran". A quiet
    // one-line note keeps the action in the transcript without resurrecting
    // the big "File not found" card this gate was built to avoid (#3966).
    const fallbackHref = safeHttpUrl(activeUrl);
    body = (
      <div
        className={cn(
          'text-muted-foreground flex items-center gap-2 px-4 py-3 text-xs',
          fill && 'h-full items-center justify-center',
        )}
      >
        <span className="truncate">
          Preview unavailable{displayTitle ? ` — ${displayTitle}` : ''}
        </span>
        {fallbackHref && (
          <a
            href={fallbackHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground/70 hover:text-foreground shrink-0 underline underline-offset-2"
          >
            Open link
          </a>
        )}
      </div>
    );
  } else {
    body = (
      <div className={cn('overflow-hidden', fill ? 'flex h-full flex-col' : 'min-h-0 flex-1')}>
        {/* Panel website header stays; inline moves these actions into the
            card header so there is only one chrome row. */}
        {isWebsitePreview && fill && (
          <div className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-4 py-1">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Globe className="text-muted-foreground/50 size-3.5 shrink-0" />
              <span className="text-foreground/80 truncate text-xs font-medium">
                {preview.displayLabel}
              </span>
            </div>
            <ServicePreviewActions preview={preview} />
          </div>
        )}

        <div className={cn(fill && 'flex min-h-0 flex-1 flex-col')}>
          {isCarousel ? (
            <ActiveServicePreviewContext.Provider value={isWebsitePreview ? preview : null}>
              <ShowCarousel
                items={items!}
                LocalhostPreview={CarouselServicePreview}
                onIndexChange={setCarouselIndex}
                fill={fill}
                toolbarActions={fill ? fileActions : undefined}
              />
            </ActiveServicePreviewContext.Provider>
          ) : isWebsitePreview ? (
            <ServicePreviewViewport preview={preview} />
          ) : (
            <>
              <div className={cn(fill && 'min-h-0 flex-1 overflow-hidden')}>
                <ShowContentRenderer
                  type={type}
                  title={title}
                  description={description}
                  path={path}
                  url={url}
                  content={content}
                  language={language}
                  aspectRatio={aspectRatio}
                  LocalhostPreview={InlineServicePreview}
                  fill={fill}
                  onStatusChange={setContentStatus}
                  toolbarActions={fill ? fileActions : undefined}
                />
              </div>
              {description && !title && (
                <div className="border-border/15 shrink-0 border-t px-5 py-3">
                  <p className="text-muted-foreground/70 text-xs">{description}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // Panel surface: `fillsPanel` (tool-part-renderer.tsx) special-cases show/
  // show-user because the preview IS the payload — keep it exactly as before,
  // filling the pane with no shell wrapper.
  if (fill) return body;

  // Inline (chat) surface: plain card — header row + always-visible payload.
  return (
    <div
      data-component="tool-trigger"
      className="bg-secondary flex w-full border-[0.5px] flex-col overflow-hidden rounded-lg"
    >
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <div className="text-foreground flex min-w-0 items-center gap-2 px-1 text-xs [&>svg]:size-4">
          {running && !type && !items ? (
            <Loading className="text-muted-foreground size-4 shrink-0" />
          ) : (
            showFileTypeIcon(headerIcon, activePath || undefined)
          )}
          <span className="min-w-0 truncate" title={displayTitle}>
            {displayTitle}
          </span>
        </div>
        {inlineToolbar ? (
          <div className="flex shrink-0 items-center gap-1">{inlineToolbar}</div>
        ) : null}
      </div>
      <div className="min-h-0 overflow-hidden">{body}</div>
    </div>
  );
}
ToolRegistry.register('show', ShowTool);
ToolRegistry.register('show-user', ShowTool);
