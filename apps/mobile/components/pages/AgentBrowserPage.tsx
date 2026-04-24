/**
 * AgentBrowserPage — dedicated viewer for the agent's Chrome browser (port 9224).
 *
 * Auto-connects to the primary session in focused mode (?session=kortix).
 * Native toolbar with back/forward that call the viewer's /input API.
 * The viewer HTML handles SSE streaming, canvas rendering, and input forwarding.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Text as RNText } from 'react-native';
import { WebView } from 'react-native-webview';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import {
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
} from 'lucide-react-native';
import { Icon } from '@/components/ui/icon';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { getSandboxPortUrl } from '@/lib/platform/client';
import { getAuthToken } from '@/api/config';
import type { PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';

const BROWSER_VIEWER_PORT = 9224;
const BROWSER_STREAM_PORT = 9223;

interface AgentBrowserPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer: () => void;
  onOpenRightDrawer: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

export function AgentBrowserPage({ page, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen }: AgentBrowserPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { sandboxId } = useSandboxContext();

  const webViewRef = useRef<WebView>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [authToken, setAuthToken] = useState<string | null>(null);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)';
  const barBg = isDark ? '#1E1E22' : '#F4F4F5';

  // Build viewer URL — auto-focus the primary session
  const viewerUrl = useMemo(() => {
    if (!sandboxId) return '';
    const base = getSandboxPortUrl(sandboxId, String(BROWSER_VIEWER_PORT));
    return `${base}?session=kortix`;
  }, [sandboxId]);

  // Build the /input API URL for sending nav commands
  const inputApiUrl = useMemo(() => {
    if (!sandboxId) return '';
    const base = getSandboxPortUrl(sandboxId, String(BROWSER_VIEWER_PORT));
    return `${base}/input?port=${BROWSER_STREAM_PORT}`;
  }, [sandboxId]);

  React.useEffect(() => {
    getAuthToken().then(setAuthToken);
  }, []);

  const handleRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsLoading(true);
    setHasError(false);
    setIsConnected(false);
    setRefreshKey((k) => k + 1);
  }, []);

  const handleOpenExternal = useCallback(() => {
    if (viewerUrl) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      Linking.openURL(viewerUrl);
    }
  }, [viewerUrl]);

  // Send navigation commands via the viewer's /input API
  const sendNavCommand = useCallback(async (type: 'nav_back' | 'nav_forward') => {
    if (!inputApiUrl || !authToken) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await fetch(inputApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ type }),
      });
    } catch {}
  }, [inputApiUrl, authToken]);

  // Listen for connection status from the WebView
  const handleMessage = useCallback((event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'connection_status') {
        setIsConnected(data.connected);
      }
    } catch {}
  }, []);

  // Inject script to report connection status back to RN and apply mobile styles
  const injectedJS = `
    (function() {
      // Report connection status changes to React Native
      var origStatus = document.getElementById('status');
      if (origStatus) {
        var observer = new MutationObserver(function() {
          var connected = origStatus.className.indexOf('connected') !== -1 && origStatus.className.indexOf('disconnected') === -1;
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'connection_status', connected: connected }));
        });
        observer.observe(origStatus, { attributes: true, attributeFilter: ['class'] });
      }

      // Mobile styles: hide the viewer's own header, make viewport fill screen
      var style = document.createElement('style');
      style.textContent = [
        'header { display: none !important; }',
        'body { padding: 0 !important; margin: 0 !important; overflow: hidden !important; }',
        'body.focused { padding: 0 !important; }',
        '#session-tabs { display: none !important; }',
        '#viewport-wrap { width: 100vw !important; max-width: 100vw !important; height: 100vh !important; max-height: 100vh !important; min-height: 100vh !important; border: none !important; border-radius: 0 !important; margin: 0 !important; aspect-ratio: auto !important; }',
        'canvas { width: 100% !important; height: 100% !important; object-fit: contain !important; border-radius: 0 !important; }',
        '#empty-state { height: 100vh !important; }',
      ].join('\\n');
      document.head.appendChild(style);

      // Force focus mode
      document.body.classList.add('focused');
    })();
    true;
  `;

  const isReady = !!viewerUrl && !!authToken;

  // Title slot: back/forward nav + live connection status (matches the
  // standard PageHeader chrome used across other pages).
  const titleNode = (
    <View className="flex-1 flex-row items-center" style={{ gap: 4 }}>
      <Pressable
        onPress={() => sendNavCommand('nav_back')}
        disabled={!isConnected}
        hitSlop={6}
        style={{ padding: 6, opacity: isConnected ? 1 : 0.3 }}
      >
        <ArrowLeft size={16} color={fg} />
      </Pressable>
      <Pressable
        onPress={() => sendNavCommand('nav_forward')}
        disabled={!isConnected}
        hitSlop={6}
        style={{ padding: 6, opacity: isConnected ? 1 : 0.3 }}
      >
        <ArrowRight size={16} color={fg} />
      </Pressable>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 8 }}>
        <View style={{
          width: 6, height: 6, borderRadius: 3,
          backgroundColor: isConnected ? '#22C55E' : isLoading && isReady ? '#F59E0B' : muted,
        }} />
        <RNText
          style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: isConnected ? '#22C55E' : muted }}
          numberOfLines={1}
        >
          {isConnected ? 'Connected' : isLoading && isReady ? 'Connecting...' : 'Idle'}
        </RNText>
      </View>
    </View>
  );

  const rightActions = (
    <View className="flex-row items-center">
      <Pressable onPress={handleRefresh} hitSlop={6} style={{ padding: 6 }}>
        <RefreshCw size={15} color={fg} />
      </Pressable>
      <Pressable onPress={handleOpenExternal} hitSlop={6} style={{ padding: 6, marginLeft: 2 }}>
        <ExternalLink size={15} color={muted} />
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
      {/* Content */}
      {!isReady ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="small" color={muted} />
          <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, marginTop: 10 }}>
            Connecting to browser...
          </RNText>
        </View>
      ) : hasError ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 }}>
          <AlertTriangle size={32} color="#F59E0B" />
          <RNText style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg, marginTop: 12 }}>
            Browser unavailable
          </RNText>
          <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, marginTop: 4, textAlign: 'center', lineHeight: 18 }}>
            The browser viewer (port {BROWSER_VIEWER_PORT}) is not reachable.
          </RNText>
          <Pressable
            onPress={handleRefresh}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              marginTop: 16, paddingHorizontal: 16, paddingVertical: 10,
              borderRadius: 10, borderWidth: 1,
              borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
            }}
          >
            <RefreshCw size={14} color={fg} />
            <RNText style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</RNText>
          </Pressable>
        </View>
      ) : (
        <WebView
          key={refreshKey}
          ref={webViewRef}
          source={{
            uri: viewerUrl,
            headers: { Authorization: `Bearer ${authToken}` },
          }}
          onLoadStart={() => setIsLoading(true)}
          onLoadEnd={() => setIsLoading(false)}
          onError={() => { setIsLoading(false); setHasError(true); }}
          onHttpError={(e) => {
            if (e.nativeEvent.statusCode >= 400) {
              setIsLoading(false);
              setHasError(true);
            }
          }}
          onMessage={handleMessage}
          injectedJavaScript={injectedJS}
          startInLoadingState
          renderLoading={() => (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? '#0a0a0a' : '#F5F6F8' }}>
              <ActivityIndicator size="small" color={muted} />
            </View>
          )}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          sharedCookiesEnabled
          allowsFullscreenVideo
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          style={{ flex: 1, backgroundColor: isDark ? '#0a0a0a' : '#F5F6F8' }}
        />
      )}
      </PageContent>
    </View>
  );
}
