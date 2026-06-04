/**
 * Inline slide thumbnail component for displaying created slides in chat
 * Fetches metadata and displays a 16:9 slide preview thumbnail
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Pressable, LayoutChangeEvent } from 'react-native';
import { Text } from '@/components/ui/text';
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

  // Fetch metadata to get proper slide URL
  useEffect(() => {
    if (!sandboxUrl || !slideInfo?.presentationName) {
      setIsLoadingMetadata(false);
      return;
    }

    const fetchMetadata = async () => {
      try {
        const sanitizedName = slideInfo.presentationName.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
        const metadataUrl = constructHtmlPreviewUrl(
          sandboxUrl,
          `presentations/${sanitizedName}/metadata.json`
        );

        const response = await fetch(`${metadataUrl}?t=${Date.now()}`, {
          cache: 'no-cache',
          headers: { 'Cache-Control': 'no-cache' },
        });

        if (response.ok) {
          const data = await response.json();
          const slideData = data.slides?.[slideInfo.slideNumber];
          if (slideData?.file_path) {
            const url = constructHtmlPreviewUrl(sandboxUrl, slideData.file_path);
            setSlideUrl(url);
          }
        }
      } catch (e) {
        log.error('[SlideInlineThumbnail] Failed to load slide metadata:', e);
      } finally {
        setIsLoadingMetadata(false);
      }
    };

    fetchMetadata();
  }, [sandboxUrl, slideInfo?.presentationName, slideInfo?.slideNumber]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setContainerWidth(width);
  }, []);

  const isLoading = externalLoading || isLoadingMetadata;
  const showShimmer = isLoading || !slideUrl || !iframeLoaded;

  // Calculate scale: container width / original slide width (1920)
  const scale = containerWidth > 0 ? containerWidth / 1920 : 0;
  const containerHeight = containerWidth > 0 ? containerWidth * (9 / 16) : 0;

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
    <Pressable onPress={onClick}>
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
              key={`slide-${slideInfo.slideNumber}`}
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
