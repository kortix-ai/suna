'use client';

import Loading from '@/components/ui/loading';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { prefersPreviewLink } from '@/features/session/preview-url-fallback';
import {
  isShowContentUnavailable,
  type ShowLoadStatus,
} from '@/features/session/show-availability';
import {
  InlineServicePreview,
  partInput,
  ServicePreviewActions,
  type ServicePreviewState,
  ToolRunningContext,
  ToolSurfaceContext,
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
  showTypeIcon,
  useServicePreview,
} from '@/features/session/tool/shared/show-helpers';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { safeHttpUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';
import { isAppRouteUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { GlobeIcon as Globe } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

// Concave corner that joins a raised tab into the strip behind it.
// Same path as the marketing web-panel / interactive-demo scallops.
function TabScallopEdge({ side }: { side: 'left' | 'right' }) {
  const path = side === 'right' ? 'M0 0C0 32 16 64 38 64L0 64Z' : 'M38 0C38 32 22 64 0 64L38 64Z';
  return (
    <svg
      viewBox="0 0 38 64"
      fill="none"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="text-secondary mt-auto h-full w-3.5 shrink-0 self-stretch overflow-visible"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}

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

  const activeHasLocalhostUrl = !!parseLocalhostUrl(activeUrl) && !isAppRouteUrl(activeUrl);

  const activeIsHtmlFilePath =
    !!activePath &&
    SHOW_HTML_EXT_RE.test(activePath) &&
    (activeType === 'file' || activeType === 'html');

  const resolvedPreviewUrl = activeHasLocalhostUrl
    ? activeUrl
    : activeIsHtmlFilePath
      ? buildHtmlStaticUrl(activePath)
      : '';
  const isWebsitePreview = !!resolvedPreviewUrl;

  /**
   * A file-backed show gets its actions INSIDE the renderer's own header —
   * `ShowContentRenderer` routes them to each viewer's native toolbar slot, or
   * supplies the row itself for the viewers that ship none. There is never a
   * second header stacked above the viewer.
   *
   * On the inline (chat) surface the scallop shell owns the toolbar tab, so
   * these stay out of the renderer there and only land in the right tab.
   */
  const fileActions =
    !isWebsitePreview && activePath ? (
      <ShowFileActions path={activePath} inPanel={fill} />
    ) : undefined;
  const preview = useServicePreview(
    resolvedPreviewUrl,
    activeTitle || title || description || undefined,
    sessionId,
  );

  // Precomputed up front (pure derivations over state already resolved above)
  // so both the loading body and the main body can feed the same safe title
  // into the inline row below — mirrors the `showLabel`-style precedence
  // (title > description/domain fallback > generic label), never the raw
  // path/URL. `showDomain` echoes its input verbatim when URL parsing fails,
  // so the type==='url' fallback is gated through `safeHttpUrl` first (the
  // same pattern show-content-renderer.tsx uses): a relative or non-http(s)
  // value never reaches the always-visible subtitle — it degrades to 'Link'.
  const safeSubtitleUrl = type === 'url' ? safeHttpUrl(url) : null;
  const displayTitle = isCarousel
    ? title || `${items!.length} items`
    : title ||
      (type === 'error'
        ? 'Error'
        : type === 'url'
          ? (safeSubtitleUrl && showDomain(safeSubtitleUrl)) || 'Link'
          : 'Output');

  const headerIcon = isCarousel ? currentItem?.type || 'image' : isWebsitePreview ? 'url' : type;

  // Inline shell owns the toolbar in its right scallop tab. Panel keeps the
  // actions inside the renderer / website header as before.
  const inlineToolbar = isWebsitePreview ? (
    <ServicePreviewActions preview={preview} />
  ) : (
    fileActions
  );
  const hasInlineToolbar = !!inlineToolbar;

  let body: ReactNode;

  if (running && !type && !items) {
    // Only the panel surface (no trigger button) still needs the bespoke
    // loading card. Inline, the left scallop tab carries the running spinner.
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
      previewIsLinkOnly: prefersPreviewLink(preview.previewUrl),
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
            right scallop tab so the shell is the only chrome. */}
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

  // Inline (chat) surface: scalloped panel shell — left tab is the file name,
  // right tab is the toolbar. Content always visible; no disclosure.
  return (
    <div data-component="tool-trigger" className="flex w-full flex-col">
      {/* `items-stretch` + matching `py-1` keep left/right tabs one height.
          `items-center` + asymmetric padding floated them off the shared
          baseline (toolbar buttons are taller than the title text). */}
      <div className="shadow-custom flex w-full items-stretch justify-between overflow-hidden">
        <span
          aria-current="page"
          className="text-foreground relative flex min-w-0 shrink items-stretch"
        >
          <span className="bg-secondary relative z-10 flex h-full min-w-0 items-center gap-2 rounded-t-lg px-3.5 py-0.5 text-xs [&>svg]:size-4">
            {running && !type && !items ? (
              <Loading className="text-muted-foreground size-4 shrink-0" />
            ) : (
              showTypeIcon(headerIcon)
            )}
            <span className="min-w-0 truncate" title={displayTitle}>
              {displayTitle}
            </span>
          </span>
          <TabScallopEdge side="right" />
        </span>

        {hasInlineToolbar && (
          <span className="text-foreground relative flex shrink-0 items-stretch">
            <TabScallopEdge side="left" />
            <span className="bg-secondary relative z-10 flex h-full items-center gap-1 rounded-t-lg px-2 py-0.5">
              {inlineToolbar}
            </span>
          </span>
        )}
      </div>

      <div
        className={cn(
          'bg-secondary flex min-h-0 w-full flex-col overflow-hidden rounded-b-lg',
          // Left tab covers top-left. Without a right toolbar tab the
          // top-right of the content plane is exposed — round it.
          !hasInlineToolbar && 'rounded-tr-lg',
        )}
      >
        <div className="min-h-0 overflow-hidden">{body}</div>
      </div>
    </div>
  );
}
ToolRegistry.register('show', ShowTool);
ToolRegistry.register('show-user', ShowTool);
