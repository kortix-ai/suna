import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  RefreshCw,
  X,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { getSandboxPortUrl } from '@/lib/platform/client';
import { useTabStore, type PageTab } from '@/stores/tab-store';
import { getAuthToken } from '@/api/config';
import * as Linking from 'expo-linking';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';

interface BrowserPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer: () => void;
  onOpenRightDrawer: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

export function BrowserPage({ page, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen }: BrowserPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { sandboxId } = useSandboxContext();

  const webViewRef = useRef<WebView>(null);

  // Restore persisted state from tab store
  const savedState = useTabStore((s) => s.tabStateById[page.id]) as { savedUrl?: string; savedDisplay?: string } | undefined;

  const [urlInput, setUrlInput] = useState(savedState?.savedDisplay || '');
  const [currentUrl, setCurrentUrl] = useState(savedState?.savedUrl || '');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);

  // Save state when unmounting (tab switch)
  const currentUrlRef = useRef(currentUrl);
  const urlInputRef = useRef(urlInput);
  currentUrlRef.current = currentUrl;
  urlInputRef.current = urlInput;

  React.useEffect(() => {
    return () => {
      useTabStore.getState().setTabState(page.id, {
        savedUrl: currentUrlRef.current,
        savedDisplay: urlInputRef.current,
      });
    };
  }, [page.id]);

  // Get initial URL from tab metadata or default
  const initialPort = (page as any).metadata?.port as number | undefined;
  const initialUrl = (page as any).metadata?.url as string | undefined;

  const getProxyUrl = useCallback((port: number, path?: string): string => {
    if (!sandboxId) return '';
    const base = getSandboxPortUrl(sandboxId, String(port));
    return path ? `${base}${path}` : base;
  }, [sandboxId]);

  // Resolve initial URL
  const resolvedInitialUrl = React.useMemo(() => {
    if (initialUrl) return initialUrl;
    if (initialPort && sandboxId) return getProxyUrl(initialPort);
    // Default: show a blank page with instructions
    return '';
  }, [initialUrl, initialPort, sandboxId, getProxyUrl]);

  // Fetch auth token on mount; only set URL if no saved state
  React.useEffect(() => {
    getAuthToken().then((token) => {
      setAuthToken(token);
      if (!currentUrl && resolvedInitialUrl) {
        setCurrentUrl(resolvedInitialUrl);
        setUrlInput(formatDisplayUrl(resolvedInitialUrl));
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedInitialUrl]);

  const handleNavigationChange = useCallback((nav: WebViewNavigation) => {
    setCanGoBack(nav.canGoBack);
    setCanGoForward(nav.canGoForward);
    setCurrentUrl(nav.url);
    if (!isEditing) {
      setUrlInput(formatDisplayUrl(nav.url));
    }
    setIsLoading(nav.loading);
  }, [isEditing]);

  const handleGoBack = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    webViewRef.current?.goBack();
  }, []);

  const handleGoForward = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    webViewRef.current?.goForward();
  }, []);

  const handleRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    webViewRef.current?.reload();
  }, []);

  const handleStop = useCallback(() => {
    webViewRef.current?.stopLoading();
    setIsLoading(false);
  }, []);

  const handleOpenExternal = useCallback(() => {
    if (currentUrl) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      Linking.openURL(currentUrl);
    }
  }, [currentUrl]);

  const handleUrlSubmit = useCallback(() => {
    setIsEditing(false);
    let url = urlInput.trim();
    if (!url) return;

    // Parse shorthand inputs
    if (/^:\d+/.test(url)) {
      // :3000 → proxy URL for that port
      const port = parseInt(url.slice(1), 10);
      url = getProxyUrl(port);
    } else if (/^\d+$/.test(url)) {
      // Just a port number
      url = getProxyUrl(parseInt(url, 10));
    } else if (/^localhost:\d+/.test(url)) {
      const port = parseInt(url.split(':')[1], 10);
      const path = url.includes('/') ? '/' + url.split('/').slice(1).join('/') : '';
      url = getProxyUrl(port, path);
    } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }

    setCurrentUrl(url);
    setUrlInput(formatDisplayUrl(url));
  }, [urlInput, getProxyUrl]);

  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#888' : '#999';
  const barBg = isDark ? '#1E1E22' : '#F4F4F5';
  const inputBg = isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)';

  // URL bar + inline nav buttons, passed into PageHeader's title slot so
  // the browser toolbar inherits the standard `bg-muted` header chrome
  // (matching Secrets / Memory / LLM Providers pages).
  const titleNode = (
    <View className="flex-1 flex-row items-center" style={{ gap: 2 }}>
      <Pressable onPress={handleGoBack} disabled={!canGoBack} hitSlop={6} className="p-1">
        <Icon as={ArrowLeft} size={16} style={{ color: canGoBack ? fgColor : mutedColor }} strokeWidth={2.2} />
      </Pressable>
      <Pressable onPress={handleGoForward} disabled={!canGoForward} hitSlop={6} className="p-1 mr-1">
        <Icon as={ArrowRight} size={16} style={{ color: canGoForward ? fgColor : mutedColor }} strokeWidth={2.2} />
      </Pressable>

      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: inputBg,
          height: 32,
          maxHeight: 32,
          borderRadius: 8,
          paddingHorizontal: 10,
          marginHorizontal: 4,
          overflow: 'hidden',
        }}
      >
        {!isLoading && <Icon as={Globe} size={12} style={{ color: mutedColor }} strokeWidth={2} />}
        {isLoading && <ActivityIndicator size={10} color={mutedColor} />}
        <TextInput
          value={urlInput}
          onChangeText={setUrlInput}
          onFocus={() => { setIsEditing(true); setUrlInput(currentUrl); }}
          onBlur={() => setIsEditing(false)}
          onSubmitEditing={handleUrlSubmit}
          placeholder="Enter URL or port..."
          placeholderTextColor={mutedColor}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          selectTextOnFocus
          numberOfLines={1}
          multiline={false}
          style={{
            flex: 1,
            marginLeft: 6,
            fontSize: 12,
            fontFamily: 'Roobert',
            color: fgColor,
            paddingVertical: 0,
            height: 32,
            includeFontPadding: false,
          }}
        />
      </View>
    </View>
  );

  const rightActions = (
    <View className="flex-row items-center">
      <Pressable onPress={isLoading ? handleStop : handleRefresh} hitSlop={6} className="p-1">
        <Icon as={isLoading ? X : RefreshCw} size={15} style={{ color: fgColor }} strokeWidth={2.2} />
      </Pressable>
      <Pressable onPress={handleOpenExternal} hitSlop={6} className="p-1 ml-1">
        <Icon as={ExternalLink} size={15} style={{ color: mutedColor }} strokeWidth={2.2} />
      </Pressable>
    </View>
  );

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        title={titleNode}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        rightActions={rightActions}
      />
      <PageContent>
        {currentUrl && authToken ? (
          <WebView
            ref={webViewRef}
            source={{
              uri: currentUrl,
              headers: { Authorization: `Bearer ${authToken}` },
            }}
            onNavigationStateChange={handleNavigationChange}
            onLoadStart={() => setIsLoading(true)}
            onLoadEnd={() => setIsLoading(false)}
            startInLoadingState
            renderLoading={() => (
              <View className="absolute inset-0 items-center justify-center bg-background">
                <ActivityIndicator size="small" />
              </View>
            )}
            javaScriptEnabled
            domStorageEnabled
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            allowsFullscreenVideo
            sharedCookiesEnabled
            style={{ flex: 1 }}
          />
        ) : (
          <View className="flex-1 items-center justify-center px-8">
            <Icon as={Globe} size={32} className="text-muted-foreground/40" strokeWidth={1.5} />
            <Text className="mt-3 font-roobert-medium text-[15px] text-foreground">Browser</Text>
            <Text className="mt-1 text-center font-roobert text-xs text-muted-foreground">
              {!sandboxId
                ? 'Waiting for sandbox connection...'
                : 'Enter a URL or port number in the address bar to preview a running service.'}
            </Text>
          </View>
        )}
      </PageContent>
    </View>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDisplayUrl(url: string): string {
  try {
    // Show a compact version: strip protocol, trailing slash
    let display = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    // If it's a proxy URL, show the port part
    const portMatch = display.match(/\/p\/[^/]+\/(\d+)(\/.*)?$/);
    if (portMatch) {
      return `localhost:${portMatch[1]}${portMatch[2] || ''}`;
    }
    return display;
  } catch {
    return url;
  }
}
