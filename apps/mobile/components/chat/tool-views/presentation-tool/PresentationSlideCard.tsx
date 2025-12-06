import React, { useState, useCallback } from 'react';
import { View, Pressable, LayoutChangeEvent } from 'react-native';
import { WebView } from 'react-native-webview';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Presentation, Play } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';

const constructHtmlPreviewUrl = (sandboxUrl: string, filePath: string): string => {
  const processedPath = filePath.replace(/^\/workspace\//, '');
  const pathSegments = processedPath.split('/').map(segment => encodeURIComponent(segment));
  const encodedPath = pathSegments.join('/');
  return `${sandboxUrl}/${encodedPath}`;
};

interface SlideMetadata {
  title: string;
  filename: string;
  file_path: string;
  preview_url: string;
  created_at: string;
}

interface PresentationSlideCardProps {
  slide: SlideMetadata & { number: number };
  sandboxUrl?: string;
  onFullScreenClick?: (slideNumber: number) => void;
  className?: string;
  refreshTimestamp?: number;
  isCurrentSlide?: boolean;
}

export function PresentationSlideCard({
  slide,
  sandboxUrl,
  onFullScreenClick,
  className = '',
  refreshTimestamp,
  isCurrentSlide = false,
}: PresentationSlideCardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [containerWidth, setContainerWidth] = useState(0);

  const slidePreviewUrl = React.useMemo(() => {
    if (!sandboxUrl) return null;
    const url = constructHtmlPreviewUrl(sandboxUrl, slide.file_path);
    return refreshTimestamp ? `${url}?t=${refreshTimestamp}` : url;
  }, [sandboxUrl, slide.file_path, refreshTimestamp]);

  const handleFullScreenPress = () => {
    if (onFullScreenClick) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onFullScreenClick(slide.number);
    }
  };

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setContainerWidth(width);
  }, []);

  // Calculate the scale factor to fit 1920x1080 content into the container
  const scale = containerWidth / 1920;

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

  if (!slidePreviewUrl) {
    return (
      <View
        className={`bg-card rounded-2xl overflow-hidden ${className}`}
        style={{
          borderWidth: 1,
          borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
        }}
      >
        <View
          className="items-center justify-center"
          style={{
            aspectRatio: 16 / 9,
            backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
          }}
        >
          <Icon as={Presentation} size={40} color={isDark ? 'rgba(248, 248, 248, 0.4)' : 'rgba(18, 18, 21, 0.3)'} />
          <Text
            className="text-sm mt-3 text-muted-foreground"
          >
            No slide preview
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      className={`bg-card rounded-2xl overflow-hidden ${className}`}
      style={[
        {
          borderWidth: isCurrentSlide ? 2 : 1,
          borderColor: isCurrentSlide 
            ? (isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.2)')
            : (isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)'),
        },
      ]}
    >
      {/* Slide Preview - 16:9 */}
      <View
        onLayout={handleLayout}
        style={{
          aspectRatio: 16 / 9,
          backgroundColor: 'white',
          overflow: 'hidden',
        }}
      >
        {containerWidth > 0 && (
          <View
            style={{
              width: 1920,
              height: 1080,
              transform: [{ scale }],
              transformOrigin: 'top left',
            }}
          >
            <WebView
              key={`slide-${slide.number}-${refreshTimestamp || slide.file_path}`}
              source={{ uri: slidePreviewUrl }}
              scrollEnabled={false}
              showsVerticalScrollIndicator={false}
              showsHorizontalScrollIndicator={false}
              style={{ width: 1920, height: 1080, backgroundColor: 'white' }}
              originWhitelist={['*']}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              injectedJavaScript={injectedJS}
              onMessage={() => {}}
            />
          </View>
        )}
      </View>

      {/* Bottom bar with slide info and open button */}
      <View
        className="flex-row items-center justify-between px-3 py-2.5"
        style={{
          backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
          borderTopWidth: 1,
          borderTopColor: isDark ? 'rgba(248, 248, 248, 0.08)' : 'rgba(18, 18, 21, 0.06)',
        }}
      >
        <View className="flex-row items-center gap-2 flex-1 min-w-0">
          <View
            className="px-2 py-1 rounded"
            style={{
              backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.06)',
            }}
          >
            <Text
              className="text-xs font-mono font-medium text-foreground"
            >
              {slide.number}
            </Text>
          </View>
          {slide.title && (
            <Text
              className="text-sm flex-1 text-muted-foreground"
              numberOfLines={1}
            >
              {slide.title}
            </Text>
          )}
        </View>

        {/* Open button */}
        {onFullScreenClick && (
          <Pressable
            onPress={handleFullScreenPress}
            className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg"
            style={{
              backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.06)',
            }}
          >
            <Icon
              as={Play}
              size={12}
              color={isDark ? '#f8f8f8' : '#121215'}
              fill={isDark ? '#f8f8f8' : '#121215'}
            />
            <Text className="text-xs font-roobert-medium text-foreground">
              Open
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
