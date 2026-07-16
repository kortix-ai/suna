'use client';

import Loading from '@/components/ui/loading';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { prefersPreviewLink } from '@/features/session/preview-url-fallback';
import {
  isShowContentUnavailable,
  type ShowLoadStatus,
} from '@/features/session/show-availability';
import {
  BasicTool,
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
  SHOW_BORDER_STYLES,
  SHOW_HTML_EXT_RE,
  ShowCarousel,
  ShowCarouselItem,
  ShowContentRenderer,
  showDomain,
  showTypeIcon,
  useServicePreview,
} from '@/features/session/tool/shared/show-helpers';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { safeHttpUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';
import { isAppRouteUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { Globe } from 'lucide-react';
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

export function ShowTool({ part, sessionId, forceOpen, locked }: ToolProps) {
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
  const theme = (input.theme as string) || 'default';
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

  const borderStyle = SHOW_BORDER_STYLES[theme] || SHOW_BORDER_STYLES.default;
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

  let body: ReactNode;

  if (running && !type && !items) {
    // Only the panel surface (no shell header) still needs the bespoke
    // loading card. Inline, the BasicTool header already shows the standard
    // running chrome (spinner + shimmering subtitle) — rendering the card too
    // would double up the loading indicators.
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
    // Nothing to show on either surface — no row, no card.
    return null;
  } else {
    body = (
      <div
        className={cn(
          'overflow-hidden',
          fill ? 'flex h-full flex-col' : cn('rounded-md border', borderStyle),
        )}
      >
        {isWebsitePreview && (
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

  // Inline (chat) surface: join the shared shell. The row's own title is
  // always "Show" — the payload's resolved title is the subtitle, never a
  // raw path/URL. Expanded by default: a collapsed row would hide the exact
  // thing the agent wanted to show, defeating the tool's purpose.
  return (
    <BasicTool
      icon={showTypeIcon(headerIcon)}
      trigger={{ title: 'Show', subtitle: displayTitle }}
      defaultOpen
      forceOpen={forceOpen}
      locked={locked}
    >
      {body}
    </BasicTool>
  );
}
ToolRegistry.register('show', ShowTool);
ToolRegistry.register('show-user', ShowTool);
