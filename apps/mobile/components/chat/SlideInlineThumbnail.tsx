/**
 * Inline slide thumbnail component for displaying created slides in chat
 * Fetches metadata and displays a 16:9 slide preview thumbnail
 * Includes retry logic with exponential backoff (matching frontend behavior)
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Pressable, LayoutChangeEvent } from 'react-native';
import { WebView } from 'react-native-webview';
import { useColorScheme } from 'nativewind';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  interpolate,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { log } from '@/lib/logger';

export interface SlideInfo {
  presentationName: string;
  slideNumber: number;
  slideTitle: string;
  totalSlides: number;
}

interface SlideInlineThumbnailProps {
  slideInfo?: SlideInfo;
  sandboxUrl?: string;
  onClick?: () => void;
  isLoading?: boolean;
}

/**
 * Construct HTML preview URL from sandbox URL
 */
function constructHtmlPreviewUrl(sandboxUrl: string, filePath: string): string {
  const processedPath = filePath.replace(/^\/workspace\//, '').replace(/^\/+/, '');
  const pathSegments = processedPath.split('/').map(segment => encodeURIComponent(segment));
  const encodedPath = pathSegments.join('/');
  return `${sandboxUrl}/${encodedPath}`;
}

/**
 * Shimmer loading animation component
 */
function ShimmerSkeleton({ isDark }: { isDark: boolean }) {
  const shimmerPosition = useSharedValue(0);

  useEffect(() => {
    shimmerPosition.value = withRepeat(
      withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
      -1,
      false
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => {
    const translateX = interpolate(shimmerPosition.value, [0, 1], [-400, 400]);
    return {
      transform: [{ translateX }],
    };
  });

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
      <View
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: isDark ? '#18181b' : '#f4f4f5',
        }}
      />
      <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: 600 }, animatedStyle]}>
        <LinearGradient
          colors={[
            'transparent',
            isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
            'transparent',
          ]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={{ flex: 1, width: 600 }}
        />
      </Animated.View>
    </View>
  );
}

export function SlideInlineThumbnail({
  slideInfo,
  sandboxUrl,
  onClick,
  isLoading: externalLoading,
}: SlideInlineThumbnailProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [slideUrl, setSlideUrl] = useState<string | null>(null);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(true);
  const [containerWidth, setContainerWidth] = useState(0);

  // Refs for retry logic and current values
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoadedRef = useRef(false);
  const isMountedRef = useRef(true);
  const currentSandboxUrlRef = useRef(sandboxUrl);
  const currentSlideInfoRef = useRef(slideInfo);

  // Keep refs updated
  currentSandboxUrlRef.current = sandboxUrl;
  currentSlideInfoRef.current = slideInfo;

  const maxRetries = 10;

  // Effect to load metadata with retry logic
  // CRITICAL: Only fetch when tool is completed (externalLoading=false) AND sandboxUrl is available
  // This matches frontend behavior - show shimmer during streaming, only fetch after completion
  // The metadata.json won't exist until the tool completes and writes the file
  useEffect(() => {
    // Reset state on dependency change
    hasLoadedRef.current = false;
    setSlideUrl(null);
    setIframeLoaded(false);
    setIsLoadingMetadata(true);
    isMountedRef.current = true;

    // Clear any pending retry
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }

    // If still loading (tool not completed), show shimmer but don't fetch yet
    // The slide file won't exist until the tool completes
    if (externalLoading) {
      log.log('[SlideInlineThumbnail] Tool still loading, showing shimmer');
      return;
    }

    // If sandboxUrl is missing, keep loading state true (shimmer will show)
    // but don't try to fetch - we'll re-run this effect when sandboxUrl becomes available
    if (!sandboxUrl) {
      log.log('[SlideInlineThumbnail] No sandboxUrl yet, showing shimmer');
      return;
    }

    if (!slideInfo?.presentationName) {
      setIsLoadingMetadata(false);
      return;
    }

    log.log('[SlideInlineThumbnail] Starting metadata fetch for', slideInfo.presentationName, 'slide', slideInfo.slideNumber);

    const loadMetadata = async (retry = 0): Promise<void> => {
      // Use refs to get current values
      const currentUrl = currentSandboxUrlRef.current;
      const currentInfo = currentSlideInfoRef.current;

      if (!currentUrl || !currentInfo?.presentationName) {
        if (isMountedRef.current) {
          setIsLoadingMetadata(false);
        }
        return;
      }

      // If already loaded successfully, don't retry
      if (hasLoadedRef.current) {
        if (isMountedRef.current) {
          setIsLoadingMetadata(false);
        }
        return;
      }

      try {
        const sanitizedName = currentInfo.presentationName.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
        const metadataUrl = constructHtmlPreviewUrl(
          currentUrl,
          `presentations/${sanitizedName}/metadata.json`
        );

        const response = await fetch(`${metadataUrl}?t=${Date.now()}`, {
          cache: 'no-cache',
          headers: { 'Cache-Control': 'no-cache' },
        });

        if (!isMountedRef.current) return;

        if (response.ok) {
          const data = await response.json();
          const slideData = data.slides?.[currentInfo.slideNumber];
          if (slideData?.file_path) {
            const url = constructHtmlPreviewUrl(currentUrl, slideData.file_path);
            hasLoadedRef.current = true;
            setSlideUrl(url);
            setIsLoadingMetadata(false);

            // Clear any pending retry
            if (retryTimeoutRef.current) {
              clearTimeout(retryTimeoutRef.current);
              retryTimeoutRef.current = null;
            }
            return;
          }
        }

        // Response not ok or no slide data - schedule retry
        throw new Error(`Failed to load metadata: ${response.status}`);
      } catch (e) {
        if (!isMountedRef.current) return;

        log.warn(`[SlideInlineThumbnail] Attempt ${retry + 1}/${maxRetries} failed:`, e);

        // Retry with exponential backoff (matching frontend: Math.min(1000 * Math.pow(1.5, retry), 5000))
        if (retry < maxRetries - 1) {
          const delay = Math.min(1000 * Math.pow(1.5, retry), 5000);
          retryTimeoutRef.current = setTimeout(() => {
            loadMetadata(retry + 1);
          }, delay);
        } else {
          log.error('[SlideInlineThumbnail] Max retries reached, giving up');
          setIsLoadingMetadata(false);
        }
      }
    };

    // Start loading
    loadMetadata(0);

    return () => {
      isMountedRef.current = false;
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, [sandboxUrl, slideInfo?.presentationName, slideInfo?.slideNumber, externalLoading]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setContainerWidth(width);
  }, []);

  const isLoading = externalLoading || isLoadingMetadata;
  const showShimmer = isLoading || !slideUrl || !iframeLoaded;

  // Calculate scale: container width / original slide width (1920)
  const scale = containerWidth > 0 ? containerWidth / 1920 : 0;

  // Inject JavaScript to properly scale the slide content
  const injectedJS = `
    (function() {
      const existingViewport = document.querySelector('meta[name="viewport"]');
      if (existingViewport) existingViewport.remove();

      const viewport = document.createElement('meta');
      viewport.name = 'viewport';
      viewport.content = 'width=1920, initial-scale=1, user-scalable=no';
      document.head.appendChild(viewport);

      const style = document.createElement('style');
      style.textContent = \`
        * { box-sizing: border-box; }
        html, body {
          margin: 0;
          padding: 0;
          width: 1920px;
          height: 1080px;
          overflow: hidden;
          background: white;
        }
        body > * {
          max-width: 100%;
        }
      \`;
      document.head.appendChild(style);
      true;
    })();
  `;

  if (!slideInfo) {
    return null;
  }

  return (
    <Pressable onPress={onClick} disabled={!onClick}>
      <View
        onLayout={handleLayout}
        className="mt-2 rounded-xl overflow-hidden"
        style={{
          aspectRatio: 16 / 9,
          backgroundColor: isDark ? '#18181b' : '#f4f4f5',
        }}
      >
        {showShimmer && <ShimmerSkeleton isDark={isDark} />}
        {slideUrl && containerWidth > 0 && (
          <View
            style={{
              width: 1920,
              height: 1080,
              transform: [{ scale }],
              transformOrigin: 'top left',
              opacity: iframeLoaded ? 1 : 0,
            }}
          >
            <WebView
              key={`slide-${slideInfo.slideNumber}-${slideUrl}`}
              source={{ uri: slideUrl }}
              scrollEnabled={false}
              showsVerticalScrollIndicator={false}
              showsHorizontalScrollIndicator={false}
              style={{
                width: 1920,
                height: 1080,
                backgroundColor: 'transparent',
              }}
              originWhitelist={['*']}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              injectedJavaScript={injectedJS}
              onLoad={() => setIframeLoaded(true)}
              onMessage={() => {}}
            />
          </View>
        )}
      </View>
    </Pressable>
  );
}

export default SlideInlineThumbnail;
