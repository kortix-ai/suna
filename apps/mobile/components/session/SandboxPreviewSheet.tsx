/**
 * SandboxPreviewSheet — the in-session preview viewer (KRTX-602).
 *
 * A `show` output's localhost / HTML-file preview and a running app named
 * under a message open HERE: a full-height bottom sheet over the session, with
 * the title row's one-tap X. The session stays mounted underneath, so closing
 * returns to the exact scroll position — no reload, no drawer round-trip.
 *
 * It replaces the Browser page tab for the primary tap. The Browser page tab
 * (`BrowserPage`, opened by the explicit "open in the full browser" control)
 * still exists for back/forward/address-bar browsing, but it is no longer what
 * a preview row opens.
 *
 * The WebView carries the live Supabase `Authorization` header ONLY for the
 * sandbox-proxy origin (`isTrustedProxyUrl`), exactly as `BrowserPage` does:
 * any other origin must not see the session token.
 */

import * as React from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { API_URL, getAuthToken } from '@/api/config';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { allowBrowserNavigation, isTrustedProxyUrl } from '@/lib/utils/html-embed';
import { THEME } from '@/lib/utils/theme';
import { useToolPreviewStore } from '@/stores/tool-preview-store';

export function SandboxPreviewSheet() {
  const url = useToolPreviewStore((s) => s.url);
  const label = useToolPreviewStore((s) => s.label);
  const closePreview = useToolPreviewStore((s) => s.closePreview);
  const modalRef = React.useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const [authToken, setAuthToken] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    void getAuthToken().then((token) => {
      if (alive) setAuthToken(token);
    });
    return () => {
      alive = false;
    };
  }, []);

  // The store is the source of truth: a tap sets the URL, which presents the
  // sheet; the sheet's dismiss clears it.
  React.useEffect(() => {
    if (url) modalRef.current?.present();
  }, [url]);

  const pageBackground = THEME[colorScheme === 'dark' ? 'dark' : 'light'].background;
  const trusted = !!url && isTrustedProxyUrl(url, API_URL);
  const loading = (
    <View className="flex-1 items-center justify-center bg-background">
      <KortixLoader />
    </View>
  );

  return (
    <KortixBottomSheetModal
      ref={modalRef}
      title={label || 'Preview'}
      snapPoints={['100%']}
      enableDynamicSizing={false}
      topInset={insets.top}
      backgroundStyle={{ backgroundColor: pageBackground }}
      onDismiss={closePreview}>
      {url && authToken ? (
        <WebView
          source={{
            uri: url,
            headers: trusted ? { Authorization: `Bearer ${authToken}` } : undefined,
          }}
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={allowBrowserNavigation}
          startInLoadingState
          renderLoading={() => loading}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          style={{ flex: 1, backgroundColor: pageBackground }}
        />
      ) : (
        loading
      )}
    </KortixBottomSheetModal>
  );
}
