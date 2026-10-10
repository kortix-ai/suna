/**
 * The interactive map, full screen: MapLibre in a WebView inside a Dialog. A Dialog, not a bottom
 * sheet, so no pan-to-dismiss competes with panning the map (design.md §8). Mounted only while open.
 */
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest, WebViewOpenWindowEvent } from 'react-native-webview/lib/WebViewTypes';
import { useColorScheme } from 'nativewind';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { XIcon } from '@/lib/icons';
import { decidePreviewNavigation } from '@/lib/utils/html-embed';
import { THEME, withAlpha } from '@/lib/utils/theme';

import { openGenuiLink } from '../components/open-link';
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

export type MapSheetData = Omit<MapDocumentInput, 'script' | 'css' | 'background' | 'routeColor'>;

export function MapSheet({ title, data, onClose }: { title: string; data: MapSheetData; onClose: () => void }) {
  const { t } = useTranslation();
  const { width, height } = useWindowDimensions();
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

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
            background: withAlpha(theme.popover, 1),
            routeColor: withAlpha(theme.foreground, 0.7),
          }),
        );
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [data, theme]);

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
        {html ? (
          <WebView
            source={{ html, baseUrl: '' }}
            originWhitelist={ORIGIN_WHITELIST}
            onShouldStartLoadWithRequest={guardNavigation}
            onOpenWindow={openWindow}
            javaScriptEnabled
            cacheEnabled={false}
            incognito
            bounces={false}
            overScrollMode="never"
            textZoom={100}
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            style={{ flex: 1, backgroundColor: 'transparent' }}
          />
        ) : (
          <View className="flex-1 items-center justify-center">
            {failed ? <Text variant="muted">{t('genui.mapUnavailable', 'Map unavailable')}</Text> : <KortixLoader />}
          </View>
        )}
      </DialogContent>
    </Dialog>
  );
}
