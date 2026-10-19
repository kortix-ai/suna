/**
 * The map: MapLibre in a WebView. `MapWebView` draws it, inline in the transcript as a still picture or
 * interactive. `MapSheet` is the interactive map full screen, in a Dialog, not a bottom sheet, so no
 * pan-to-dismiss competes with panning the map (design.md §8). The sheet is mounted only while open.
 */
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest, WebViewMessageEvent, WebViewOpenWindowEvent } from 'react-native-webview/lib/WebViewTypes';
import { useColorScheme } from 'nativewind';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { XIcon } from '@/lib/icons';
import { decidePreviewNavigation } from '@/lib/utils/html-embed';
import { THEME, withAlpha } from '@/lib/utils/theme';

import type { MapPlace, PlaceAction } from '@/lib/genui/map-geo';

import { openGenuiLink, openPlaceAction } from '../components/open-link';
import { mapDocument, type MapDocumentInput } from './map-html';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SCRIPT = require('@/assets/maplibre/maplibre-gl.webjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const CSS = require('@/assets/maplibre/maplibre-gl-css.webjs');
// Every URL reaches the guard, which allows only the inline document (see MermaidRendererHost).
const ORIGIN_WHITELIST = ['*'];

/**
 * Only the inline document loads. A top-frame web link (the attribution's) opens in the browser;
 * every other navigation is blocked. Tile and style fetches are requests, not navigations.
 */
function guardNavigation(request: ShouldStartLoadRequest): boolean {
  const action = decidePreviewNavigation(request.url, { isTopFrame: request.isTopFrame });
  if (action === 'open-external') openGenuiLink(request.url);
  return action === 'allow';
}

/** A `target="_blank"` link (MapLibre's attribution links) asks for a new window: open it in the browser. */
const openWindow = (event: WebViewOpenWindowEvent) => openGenuiLink(event.nativeEvent.targetUrl);

const ACTIONS: readonly PlaceAction[] = ['directions', 'website', 'call'];

/**
 * A popup button's message: `{ type: 'place', index, action }`. The page holds no link, so native looks the
 * place up and opens its own link; any other message opens nothing.
 */
function placeMessage(markers: readonly Omit<MapPlace, 'id'>[], raw: string): void {
  let message: { type?: unknown; index?: unknown; action?: unknown };
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message?.type !== 'place' || !Number.isInteger(message.index)) return;
  const place = markers[message.index as number];
  const action = ACTIONS.find((a) => a === message.action);
  if (place && action) openPlaceAction(place, action);
}

async function readText(moduleId: number): Promise<string> {
  const asset = await Asset.fromModule(moduleId).downloadAsync();
  return new File(asset.localUri ?? asset.uri).text();
}

let bundle: Promise<{ script: string; css: string }> | null = null;
/** MapLibre's script and stylesheet, read once per app run; a failed read retries on the next open. */
function loadBundle() {
  bundle ??= Promise.all([readText(SCRIPT), readText(CSS)])
    .then(([script, css]) => ({ script, css }))
    .catch((error: unknown) => {
      bundle = null;
      throw error;
    });
  return bundle;
}

export type MapSheetData = Omit<MapDocumentInput, 'script' | 'css' | 'background' | 'routeColor' | 'pin' | 'labels' | 'interactive'>;

/** The route line: the charts' first series colour (`charts.tsx` series 0 is `--chart-3`), as web's `routeRgb`. */
const ROUTE_COLOR = withAlpha(THEME.chart[2], 1);

/** The map page in a WebView, in theme colors. Still (`interactive={false}`): no pan, zoom, or popups. */
export function MapWebView({ data, interactive = true }: { data: MapSheetData; interactive?: boolean }) {
  const { t } = useTranslation();
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const directions = t('genui.directions', 'Directions');
  const website = t('genui.website', 'Website');
  const call = t('genui.call', 'Call');

  useEffect(() => {
    let alive = true;
    loadBundle().then(
      ({ script, css }) => {
        if (!alive) return;
        setHtml(
          mapDocument({
            ...data,
            script,
            css,
            interactive,
            background: withAlpha(theme.popover, 1),
            routeColor: ROUTE_COLOR,
            pin: {
              surface: withAlpha(theme.background, 1),
              ink: withAlpha(theme.foreground, 1),
              border: withAlpha(theme.border, 1),
              shadow: withAlpha(theme.foreground, 0.18),
              muted: withAlpha(theme.secondary, 1),
            },
            labels: { directions, website, call },
          }),
        );
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [data, theme, interactive, directions, website, call]);

  if (!html) {
    return (
      <View className="flex-1 items-center justify-center">
        {failed ? <Text variant="muted">{t('genui.mapUnavailable', 'Map unavailable')}</Text> : <KortixLoader />}
      </View>
    );
  }
  return (
    <WebView
      source={{ html, baseUrl: '' }}
      originWhitelist={ORIGIN_WHITELIST}
      onShouldStartLoadWithRequest={guardNavigation}
      onOpenWindow={openWindow}
      onMessage={(event: WebViewMessageEvent) => placeMessage(data.markers, event.nativeEvent.data)}
      javaScriptEnabled
      cacheEnabled={false}
      incognito
      bounces={false}
      scrollEnabled={interactive}
      overScrollMode="never"
      textZoom={100}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      style={{ flex: 1, backgroundColor: 'transparent' }}
    />
  );
}

export function MapSheet({ title, data, onClose }: { title: string; data: MapSheetData; onClose: () => void }) {
  const { t } = useTranslation();
  const { width, height } = useWindowDimensions();
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      {/* MermaidBlock's fullscreen geometry: the window less a 16pt edge, 90% tall. */}
      <DialogContent className="gap-0 overflow-hidden p-0" style={{ width: width - 32, height: Math.round(height * 0.9) }}>
        <View className="flex-row items-center justify-between pl-4 pr-1 pt-1">
          <DialogTitle className="flex-1" numberOfLines={1}>
            {title}
          </DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" accessibilityLabel={t('common.close', 'Close')}>
              <Icon as={XIcon} size={18} />
            </Button>
          </DialogClose>
        </View>
        <MapWebView data={data} />
      </DialogContent>
    </Dialog>
  );
}
