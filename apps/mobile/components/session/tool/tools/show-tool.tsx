/**
 * `show` / `show-user`. Port of apps/web `tool/tools/show-tool.tsx`.
 *
 * Inline (chat) surface: a plain card — `bg-secondary rounded-lg
 * border-[0.5px]` — with one header row and an always-visible payload. No
 * disclosure: the payload IS the row.
 * - header (`px-2 py-1.5 gap-2`): the format glyph (`showFileTypeIcon`: file
 *   extension first, then type; a carousel shows the ACTIVE item's glyph, never
 *   an avatar group), or the loader while the input streams · the label
 *   (title, else "Error" / the URL's domain / "Link" / "Output"; a carousel
 *   "N items") · ONE toolbar: preview actions for a localhost / HTML-file
 *   preview, `ShowFileActions` (Refresh · "Preview") for a file, "Preview"
 *   for content when a panel activation exists;
 * - body: nothing for a finished show with no artifact; a quiet "Preview
 *   unavailable — title" row (with "Open link") when the artifact failed to
 *   load; else the carousel, the preview card, or `ShowContentRenderer`, with a
 *   description footer when there is no title.
 *
 * Panel surface (`ToolSurfaceContext` 'panel'): the body fills the pane with no
 * card, as on web. Mobile hosts only the inline surface today.
 *
 * Mobile keeps its open actions (`navigation.tsx`): previews open the Browser
 * tab, files open the app's file sheet (`FilePreviewSheet`), links open
 * externally. A show with
 * no toolbar but a safe external URL gets an open-link control
 * (`useShowOpenInTab`), because a phone has no hover target to reach it.
 *
 * Refresh in the file toolbar re-reads the file queries and remounts the body
 * (`refreshNonce`), so a sandbox image requests its bytes again too.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { isShowContentUnavailable, isShowPayloadEmpty, parseLocalhostUrl, type ShowLoadStatus } from '@kortix/sdk';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { ArrowSquareOutIcon, GlobeIcon, MonitorIcon } from '@/lib/icons';
import { prefersPreviewLink, safeHttpUrl } from '@/lib/session/tools/web-fetch';
import {
  SHOW_IMAGE_EXT_RE,
  parseShowItems,
  resolveShowPreviewUrl,
  resolveShowType,
  showBodyKind,
  showDisplayTitle,
  showHeaderIconType,
  showInlineToolbarKind,
  showOpenTarget,
  showRowModel,
  showUnavailableLabel,
} from '@/lib/session/tools/web-show';
import { webSpace } from '@/lib/session/user-message';
import { THEME } from '@/lib/utils/theme';
import {
  BoundActivateContext,
  InlineServicePreview,
  ServicePreviewActions,
  ServicePreviewViewport,
  ToolIconSlot,
  ToolRunningContext,
  ToolDetailContext,
  ToolEmptyState,
  ToolSurfaceContext,
  partInput,
  useServicePreview,
  useToolNavigation,
  type ServicePreviewState,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { SettingsGroup } from '@/components/kortix/settings-list';
import { ShowFileActions, ShowResultRow, showFileTypeIcon, useShowOpenInTab } from '../shared/show-helpers';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { ShowCarousel } from './show-carousel';
import { ShowContentRenderer } from './show-content-renderer';

// The header owns one preview state for the active item; the carousel reads it
// through context so its viewport and the header controls drive the same target.
const ActiveServicePreviewContext = createContext<ServicePreviewState | null>(null);

function CarouselServicePreview({ url, label }: { url: string; label?: string }) {
  const preview = useContext(ActiveServicePreviewContext);
  if (preview) return <ServicePreviewViewport preview={preview} />;
  return <InlineServicePreview url={url} label={label} />;
}

export function ShowTool({ part, sessionId }: ToolProps) {
  const palette = useTurnPalette();
  const { colorScheme } = useColorScheme();
  const input = partInput(part);
  const running = useContext(ToolRunningContext);
  const fill = useContext(ToolSurfaceContext) === 'panel';
  const detailBody = useContext(ToolDetailContext) === 'body';
  const activate = useContext(BoundActivateContext);
  const { enabled: navigationEnabled } = useToolNavigation();

  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  const title = str(input.title);
  const description = str(input.description);
  const type = str(input.type);
  const path = str(input.path);
  const url = str(input.url);
  const content = str(input.content);
  const aspectRatio = str(input.aspect_ratio);
  const language = str(input.language);

  const items = useMemo(() => parseShowItems(input.items), [input.items]);
  const isCarousel = !!items && items.length > 0;
  const [carouselIndex, setCarouselIndex] = useState(0);
  const currentItem = isCarousel ? items[carouselIndex] || items[0] : null;
  const [contentStatus, setContentStatus] = useState<ShowLoadStatus>('loading');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshNonce((n) => n + 1), []);

  const activeType = isCarousel ? currentItem?.type || '' : type;
  const activeUrl = isCarousel ? currentItem?.url || '' : url;
  const activePath = isCarousel ? currentItem?.path || '' : path;
  const activeTitle = isCarousel ? currentItem?.title || '' : title;

  const resolvedPreviewUrl = useMemo(
    () => resolveShowPreviewUrl({ activeUrl, activePath, activeType }),
    [activeUrl, activePath, activeType],
  );
  const isWebsitePreview = !!resolvedPreviewUrl;
  const preview = useServicePreview(resolvedPreviewUrl, activeTitle || title || description || undefined, sessionId);
  const previewIsLinkOnly = useMemo(() => prefersPreviewLink(preview.previewUrl), [preview.previewUrl]);
  const openInTab = useShowOpenInTab({ type: activeType, url: activeUrl, path: activePath, title: activeTitle });
  const safeActiveUrl = useMemo(() => safeHttpUrl(activeUrl), [activeUrl]);

  const displayTitle = showDisplayTitle({ isCarousel, itemCount: items?.length ?? 0, title, type, url });
  const headerIcon = showFileTypeIcon(
    showHeaderIconType({ isCarousel, currentItemType: currentItem?.type || '', isWebsitePreview, type }),
    activePath || undefined,
  );

  const toolbarKind = showInlineToolbarKind({
    isWebsitePreview,
    activePath,
    isCarousel,
    content,
    canActivate: Boolean(activate),
    navigationEnabled,
  });
  const fileActions =
    toolbarKind === 'file' ? <ShowFileActions path={activePath} inPanel={fill} onRefresh={bumpRefresh} /> : undefined;

  let inlineToolbar: ReactNode = null;
  if (toolbarKind === 'preview') inlineToolbar = <ServicePreviewActions preview={preview} />;
  else if (fileActions) inlineToolbar = fileActions;
  else if (toolbarKind === 'content-preview' && activate) {
    inlineToolbar = (
      <Button variant="secondary" size="sm" onPress={activate} accessibilityHint="Open in the panel">
        <Text>Preview</Text>
      </Button>
    );
  } else if (safeActiveUrl && navigationEnabled) {
    inlineToolbar = (
      <Button variant="ghost" size="icon" onPress={openInTab} accessibilityLabel="Open link">
        <Icon as={ArrowSquareOutIcon} size={TURN_SPACE.icon} color={palette.mutedForeground} />
      </Button>
    );
  }

  // One row per output: a carousel's items, else the single payload. A row
  // exists only for something that can be opened — a file or a URL; inline
  // content with neither keeps the renderer below.
  const rows = useMemo(() => {
    const list = isCarousel
      ? (items ?? []).map((item, index) => ({
          key: `${item.path || item.url || index}`,
          type: item.type || '',
          path: item.path || '',
          url: item.url || '',
          title: item.title || '',
        }))
      : [{ key: 'single', type, path, url, title }];
    return list
      .filter((entry) => entry.path || entry.url)
      .map((entry) => ({
        key: entry.key,
        entry: { type: entry.type, url: entry.url, path: entry.path, title: entry.title },
        directImageUrl: !entry.path && entry.url && SHOW_IMAGE_EXT_RE.test(entry.url) ? entry.url : '',
        model: showRowModel(entry),
        // A running app gets the screen glyph, never the globe (Jay, 2026-09-22).
        icon:
          !entry.path && parseLocalhostUrl(entry.url)
            ? MonitorIcon
            : showFileTypeIcon(resolveShowType(entry.type, entry.path), entry.path || undefined),
      }));
  }, [isCarousel, items, path, title, type, url]);

  const hasNothingToShow = useMemo(() => isShowPayloadEmpty({ items, path, url, content }), [items, path, url, content]);
  const bodyKind = showBodyKind({
    running,
    type,
    hasItems: Boolean(items),
    hasNothingToShow,
    unavailable: isShowContentUnavailable({
      running,
      isCarousel,
      contentStatus,
      isWebsitePreview,
      previewHasError: preview.hasError,
      previewIsLinkOnly,
    }),
  });

  if (bodyKind === 'hidden') return detailBody ? <ToolEmptyState message="No details" /> : null;

  let body: ReactNode;
  if (bodyKind === 'loading') {
    // Only the panel needs the loading card; inline, the header carries the loader.
    body = fill ? (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap3, paddingHorizontal: webSpace(5), paddingVertical: webSpace(4) }}>
          <KortixLoader customSize={TURN_SPACE.icon} />
          <TextShimmer duration={1} spread={2} style={TURN_TYPE.sm}>
            Preparing output...
          </TextShimmer>
        </View>
      </View>
    ) : null;
  } else if (bodyKind === 'unavailable') {
    // Never vanish: a quiet note keeps the action in the transcript.
    body = (
      <View
        style={[
          { flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2, paddingHorizontal: webSpace(4), paddingVertical: webSpace(3) },
          fill && { flex: 1, justifyContent: 'center' },
        ]}
      >
        <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, color: palette.mutedForeground }]}>
          {showUnavailableLabel(displayTitle)}
        </Text>
        {safeActiveUrl ? (
          <Button variant="link" size="sm" onPress={openInTab}>
            <Text>Open link</Text>
          </Button>
        ) : null}
      </View>
    );
  } else {
    body = (
      <View style={fill ? { flex: 1 } : undefined}>
        {isWebsitePreview && fill ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: TURN_SPACE.gap3,
              paddingHorizontal: webSpace(4),
              paddingVertical: webSpace(1),
              borderBottomWidth: 1,
              borderBottomColor: palette.border,
            }}
          >
            <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}>
              <GlobeIcon size={TURN_SPACE.caret} color={palette.muted50} />
              <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { flex: 1, color: palette.foreground80 }]}>
                {preview.displayLabel}
              </Text>
            </View>
            <ServicePreviewActions preview={preview} />
          </View>
        ) : null}

        {isCarousel ? (
          <ActiveServicePreviewContext.Provider value={isWebsitePreview ? preview : null}>
            <ShowCarousel
              items={items}
              LocalhostPreview={CarouselServicePreview}
              onIndexChange={setCarouselIndex}
              fill={fill}
              toolbarActions={fill ? fileActions : undefined}
              refreshKey={refreshNonce}
            />
          </ActiveServicePreviewContext.Provider>
        ) : isWebsitePreview ? (
          <ServicePreviewViewport preview={preview} />
        ) : (
          <>
            <ShowContentRenderer
              key={refreshNonce}
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
            {description && !title ? (
              <View style={{ paddingHorizontal: webSpace(5), paddingVertical: webSpace(3), borderTopWidth: 1, borderTopColor: palette.border10 }}>
                <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted70 }]}>
                  {description}
                </Text>
              </View>
            ) : null}
          </>
        )}
      </View>
    );
  }

  if (fill) return <>{body}</>;

  // ── The transcript's surface: one row per output (COR-107, option B) ──
  //
  // A row names the output and opens it in the file sheet; the payload is
  // never embedded in the bubble. The panel and the activity sheet's detail
  // body keep the full renderer above.
  if (!detailBody && rows.length > 0 && bodyKind === 'content') {
    return (
      <SettingsGroup parentClassName='rounded-lg'>
        {rows.map((row) => (
          <ShowResultRow
            key={row.key}
            entry={row.entry}
            model={row.model}
            icon={row.icon}
            directImageUrl={row.directImageUrl || undefined}
          />
        ))}
      </SettingsGroup>
    );
  }

  return (
    <View
      style={{
        width: '100%',
        overflow: 'hidden',
        borderRadius: 10,
        borderWidth: 0.5,
        borderColor: palette.border,
        backgroundColor: colorScheme === 'dark' ? THEME.dark.secondary : THEME.light.secondary,
      }}
    >
      {/* The activity sheet's detail header names the payload: keep only its actions. */}
      {detailBody && !inlineToolbar ? null : (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: TURN_SPACE.gap2,
            paddingHorizontal: webSpace(2),
            paddingVertical: webSpace(1.5),
          }}
        >
          {detailBody ? (
            <View />
          ) : (
            <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2, paddingHorizontal: webSpace(1) }}>
              {running && !type && !items ? (
                <KortixLoader customSize={TURN_SPACE.icon} />
              ) : (
                <ToolIconSlot icon={headerIcon} size={TURN_SPACE.icon} color={palette.foreground} />
              )}
              <Text variant="muted" numberOfLines={1} accessibilityLabel={displayTitle} style={[TURN_TYPE.xs, { flexShrink: 1, color: palette.foreground }]}>
                {displayTitle}
              </Text>
            </View>
          )}
          {inlineToolbar ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1) }}>{inlineToolbar}</View> : null}
        </View>
      )}
      <View style={{ overflow: 'hidden' }}>{body}</View>
    </View>
  );
}
ToolRegistry.register('show', ShowTool);
ToolRegistry.register('show-user', ShowTool);
