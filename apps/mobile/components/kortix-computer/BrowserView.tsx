import React, { useState, useEffect, useMemo } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Globe, RefreshCw, AlertCircle } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { WebView } from 'react-native-webview';

interface BrowserViewProps {
  sandbox?: {
    id?: string;
    sandbox_url?: string;
    vnc_preview?: string;
    pass?: string;
  };
}

export function BrowserView({ sandbox }: BrowserViewProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const webViewRef = React.useRef<WebView>(null);
  const [isBrowserLoading, setIsBrowserLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Construct VNC URL with password, matching frontend implementation
  const vncUrl = useMemo(() => {
    // Log sandbox data for debugging
    console.log('[BrowserView] Sandbox data:', {
      vnc_preview: sandbox?.vnc_preview,
      pass: sandbox?.pass ? '***' : undefined,
      hasPass: !!sandbox?.pass,
      sandboxId: sandbox?.id,
    });

    if (!sandbox?.vnc_preview || !sandbox?.pass) {
      console.log('[BrowserView] Missing VNC URL or password');
      return null;
    }
    // Match frontend URL construction: /vnc_lite.html?password=${pass}&autoconnect=true&scale=local
    const constructedUrl = `${sandbox.vnc_preview}/vnc_lite.html?password=${sandbox.pass}&autoconnect=true&scale=local`;
    console.log('[BrowserView] Constructed VNC URL:', constructedUrl.replace(/password=[^&]+/, 'password=***'));
    return constructedUrl;
  }, [sandbox?.vnc_preview, sandbox?.pass]);

  const handleRefresh = () => {
    setIsBrowserLoading(true);
    setConnectionError(null);
    webViewRef.current?.reload();
  };

  // Show loading overlay for a few seconds after WebView loads to let browser initialize
  useEffect(() => {
    if (vncUrl && isBrowserLoading) {
      const timer = setTimeout(() => {
        setIsBrowserLoading(false);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [vncUrl, isBrowserLoading]);

  // Reset loading state when sandbox changes
  useEffect(() => {
    setIsBrowserLoading(true);
    setConnectionError(null);
  }, [sandbox?.id]);

  // Handle WebView errors
  const handleError = (syntheticEvent: any) => {
    const { nativeEvent } = syntheticEvent;
    console.error('WebView error:', nativeEvent);
    setConnectionError('Failed to load browser connection');
    setIsBrowserLoading(false);
  };

  // Handle HTTP errors
  const handleHttpError = (syntheticEvent: any) => {
    const { nativeEvent } = syntheticEvent;
    console.error('WebView HTTP error:', nativeEvent);
    if (nativeEvent.statusCode >= 400) {
      setConnectionError(`Connection error (${nativeEvent.statusCode})`);
      setIsBrowserLoading(false);
    }
  };

  if (vncUrl) {
    return (
      <View className="flex-1">
        {/* Header */}
        <View
          className="px-4 py-2 border-b flex-row items-center justify-between"
          style={{
            backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
            borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
          }}
        >
          <View className="flex-row items-center gap-2">
            <View className="w-2 h-2 rounded-full bg-green-500" />
            <Text className="text-sm font-roobert-medium">
              Browser Connected
            </Text>
          </View>
          <View
            onTouchEnd={handleRefresh}
            className="p-2 rounded-lg active:opacity-70"
            style={{
              backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.05)',
            }}
          >
            <Icon
              as={RefreshCw}
              size={16}
              color={isDark ? '#f8f8f8' : '#121215'}
              strokeWidth={2}
            />
          </View>
        </View>

        {/* VNC Preview */}
        <View className="flex-1 relative">
          <WebView
            ref={webViewRef}
            source={{ uri: vncUrl }}
            style={{ flex: 1 }}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            startInLoadingState={true}
            scalesPageToFit={true}
            onLoadEnd={() => {
              // WebView loaded, but give browser time to initialize
              setTimeout(() => {
                setIsBrowserLoading(false);
                setConnectionError(null);
              }, 2000);
            }}
            onError={handleError}
            onHttpError={handleHttpError}
          />
          {connectionError ? (
            <View 
              className="absolute inset-0 items-center justify-center bg-background/95"
            >
              <View className="items-center space-y-3 px-4">
                <Icon
                  as={AlertCircle}
                  size={32}
                  color={isDark ? '#ef4444' : '#dc2626'}
                  strokeWidth={2}
                />
                <Text className="text-sm font-roobert-semibold text-center text-foreground">
                  Connection Failed
                </Text>
                <Text className="text-xs text-muted-foreground text-center">
                  {connectionError}
                </Text>
                <View
                  onTouchEnd={handleRefresh}
                  className="mt-2 px-4 py-2 rounded-lg active:opacity-70"
                  style={{
                    backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                  }}
                >
                  <Text className="text-sm font-roobert-medium text-foreground">
                    Retry
                  </Text>
                </View>
              </View>
            </View>
          ) : isBrowserLoading ? (
            <View 
              className="absolute inset-0 items-center justify-center bg-background/95"
            >
              <View className="items-center space-y-3">
                <ActivityIndicator size="large" color={isDark ? '#F8F8F8' : '#121215'} />
                <Text className="text-sm font-roobert-medium text-center text-foreground">
                  Connecting to browser...
                </Text>
              </View>
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  // Show error state if we have vnc_preview but missing password
  if (sandbox?.vnc_preview && !sandbox?.pass) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <View className="flex-col items-center space-y-4 max-w-sm">
          <View className="w-16 h-16 rounded-full items-center justify-center border-2"
            style={{
              backgroundColor: isDark ? 'rgba(239, 68, 68, 0.1)' : 'rgba(220, 38, 38, 0.1)',
              borderColor: isDark ? 'rgba(239, 68, 68, 0.3)' : 'rgba(220, 38, 38, 0.3)',
            }}
          >
            <Icon
              as={AlertCircle}
              size={32}
              color={isDark ? '#ef4444' : '#dc2626'}
              strokeWidth={2}
            />
          </View>
          <View className="space-y-2">
            <Text className="text-lg font-roobert-semibold text-center">
              Connection Error
            </Text>
            <Text className="text-sm text-muted-foreground text-center leading-relaxed">
              Browser URL is available but password is missing. Please check sandbox configuration.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center p-8">
      <View className="flex-col items-center space-y-4 max-w-sm">
        <View className="w-16 h-16 rounded-full items-center justify-center border-2"
          style={{
            backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.05)',
            borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
          }}
        >
          <Icon
            as={Globe}
            size={32}
            color={isDark ? 'rgba(248, 248, 248, 0.4)' : 'rgba(18, 18, 21, 0.4)'}
            strokeWidth={1.5}
          />
        </View>
        <View className="space-y-2">
          <Text className="text-lg font-roobert-semibold text-center">
            Browser not available
          </Text>
          <Text className="text-sm text-muted-foreground text-center leading-relaxed">
            No active browser session available. The browser will appear here when a sandbox is created and Browser tools are used.
          </Text>
        </View>
      </View>
    </View>
  );
}

