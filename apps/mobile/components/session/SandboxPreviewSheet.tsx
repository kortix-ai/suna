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
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
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
  // The store is the source of truth: a tap sets the URL, which presents the
  // sheet; the sheet's dismiss clears it.
  React.useEffect(() => {
    if (url) modalRef.current?.present();
  }, [url]);

  const pageBackground = THEME[colorScheme === 'dark' ? 'dark' : 'light'].background;

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
      // The page scrolls inside the WebView. A content pan would take the drag
      // on Android, so only the handle and title row drag the sheet.
      enablePanDownToClose
      enableContentPanningGesture={false}
      backgroundStyle={{ backgroundColor: pageBackground }}
      onDismiss={closePreview}>
      {url ? <PreviewPage key={url} url={url} pageBackground={pageBackground} loading={loading} /> : loading}
    </KortixBottomSheetModal>
  );
}

// A URL owns its credential request. Changing or closing it unmounts this
// page, so an old credential cannot render even before the next effect runs.
function PreviewPage({ url, pageBackground, loading }: {
  url: string;
  pageBackground: string;
  loading: React.ReactElement;
}) {
  const trusted = isTrustedProxyUrl(url, API_URL);
  const [credential, setCredential] = React.useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ready'; token: string }
  >({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!trusted) return;
    let alive = true;
    void getAuthToken().then(
      (token) => {
        if (alive) setCredential(token ? { status: 'ready', token } : { status: 'error' });
      },
      () => { if (alive) setCredential({ status: 'error' }); },
    );
    return () => { alive = false; };
  }, [trusted, attempt]);

  if (trusted && credential.status === 'loading') return loading;
  if (trusted && credential.status === 'error') {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-background px-8">
        <Text variant="muted" className="text-center" accessibilityLiveRegion="polite">
          Unable to load preview credentials. Try again.
        </Text>
        <Button variant="secondary" size="sm" className="rounded-full"
          accessibilityLabel="Retry preview credentials"
          onPress={() => {
            setCredential({ status: 'loading' });
            setAttempt((value) => value + 1);
          }}>
          <Text>Retry</Text>
        </Button>
      </View>
    );
  }
  return (
    <WebView
      source={{
        uri: url,
        headers: trusted && credential.status === 'ready'
          ? { Authorization: `Bearer ${credential.token}` } : undefined,
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
  );
}
