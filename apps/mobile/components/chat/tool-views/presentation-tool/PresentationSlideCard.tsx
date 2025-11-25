import React, { useState } from 'react';
import { View, Pressable, LayoutChangeEvent } from 'react-native';
import { WebView } from 'react-native-webview';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Maximize2, Presentation } from 'lucide-react-native';

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
  showFullScreenButton?: boolean;
  refreshTimestamp?: number;
}

export function PresentationSlideCard({
  slide,
  sandboxUrl,
  onFullScreenClick,
  className = '',
  showFullScreenButton = true,
  refreshTimestamp,
}: PresentationSlideCardProps) {
  const [containerDimensions, setContainerDimensions] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);

  const slidePreviewUrl = React.useMemo(() => {
    if (!sandboxUrl) return null;
    const url = constructHtmlPreviewUrl(sandboxUrl, slide.file_path);
    return refreshTimestamp ? `${url}?t=${refreshTimestamp}` : url;
  }, [sandboxUrl, slide.file_path, refreshTimestamp]);

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setContainerDimensions({ width, height });
      
      // Calculate scale to fit 1920x1080 into container while maintaining aspect ratio
      const scaleX = width / 1920;
      const scaleY = height / 1080;
      const newScale = Math.min(scaleX, scaleY);
      
      // Only update if scale actually changed significantly
      if (Math.abs(newScale - scale) > 0.001) {
        setScale(newScale);
      }
    }
  };

  if (!slidePreviewUrl) {
    return (
      <View className={`bg-card border border-border rounded-2xl overflow-hidden ${className}`}>
      <View className="px-3 py-2 bg-muted/20 border-b border-border/40 flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <View className="h-6 px-2 rounded border border-border bg-background items-center justify-center">
            <Text className="text-xs font-mono text-foreground">#{slide.number}</Text>
          </View>
          {slide.title && (
            <Text className="text-sm text-muted-foreground flex-1" numberOfLines={1}>
              {slide.title}
            </Text>
          )}
        </View>
      </View>
        <View className="flex items-center justify-center h-48 bg-muted/30">
          <Icon as={Presentation} size={48} className="text-muted-foreground mb-4" />
          <Text className="text-sm text-muted-foreground">No slide content to preview</Text>
        </View>
      </View>
    );
  }

  const scaledWidth = 1920 * scale;
  const scaledHeight = 1080 * scale;
  const leftOffset = (containerDimensions.width - scaledWidth) / 2;

  return (
    <View 
      className={`bg-card border border-border rounded-2xl overflow-hidden ${className}`}
    >
      {/* Slide header */}
      <View className="px-3 py-2 bg-muted/20 border-b border-border/40 flex-row items-center justify-between">
        <View className="flex-row items-center gap-2 flex-1">
          <View className="h-6 px-2 rounded border border-border bg-background items-center justify-center">
            <Text className="text-xs font-mono text-foreground">#{slide.number}</Text>
          </View>
          {slide.title && (
            <Text className="text-sm text-muted-foreground flex-1" numberOfLines={1}>
              {slide.title}
            </Text>
          )}
        </View>
        {showFullScreenButton !== false && onFullScreenClick && (
          <Pressable
            onPress={() => onFullScreenClick(slide.number)}
            className="h-8 w-8 items-center justify-center"
          >
            <Icon as={Maximize2} size={16} className="text-muted-foreground" />
          </Pressable>
        )}
      </View>
      
      {/* Slide Preview */}
      <Pressable
        onPress={() => onFullScreenClick?.(slide.number)}
        className="relative bg-muted/30"
        style={{ aspectRatio: 16 / 9 }}
      >
        <View 
          className="relative w-full h-full bg-background rounded-lg overflow-hidden"
          onLayout={handleLayout}
        >
          {containerDimensions.width > 0 && containerDimensions.height > 0 && (
            <WebView
              key={`slide-${slide.number}-${refreshTimestamp || slide.file_path}`}
              source={{ uri: slidePreviewUrl }}
              scrollEnabled={false}
              showsVerticalScrollIndicator={false}
              showsHorizontalScrollIndicator={false}
              style={{
                width: containerDimensions.width,
                height: containerDimensions.height,
                backgroundColor: 'transparent',
              }}
              originWhitelist={['*']}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              allowsInlineMediaPlayback={true}
              mediaPlaybackRequiresUserAction={false}
              scalesPageToFit={false}
              injectedJavaScript={`
                (function() {
                  const scale = ${scale};
                  const containerWidth = ${containerDimensions.width};
                  const containerHeight = ${containerDimensions.height};
                  
                  // Set viewport
                  let viewport = document.querySelector('meta[name="viewport"]');
                  if (!viewport) {
                    viewport = document.createElement('meta');
                    viewport.name = 'viewport';
                    document.head.appendChild(viewport);
                  }
                  viewport.content = 'width=1920, initial-scale=' + scale + ', maximum-scale=' + scale + ', user-scalable=no';
                  
                  // Inject scaling CSS
                  const styleId = 'presentation-slide-scale-style';
                  let style = document.getElementById(styleId);
                  if (!style) {
                    style = document.createElement('style');
                    style.id = styleId;
                    document.head.appendChild(style);
                  }
                  style.textContent = \`
                    html {
                      width: 1920px;
                      height: 1080px;
                      overflow: hidden;
                    }
                    body {
                      margin: 0;
                      padding: 0;
                      width: 1920px;
                      height: 1080px;
                      overflow: hidden;
                      transform: scale(\${scale});
                      transform-origin: top left;
                      position: relative;
                    }
                    body > * {
                      width: 1920px;
                      height: 1080px;
                    }
                  \`;
                  
                  // Wait for content to load
                  if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', function() {
                      window.ReactNativeWebView.postMessage('loaded');
                    });
                  } else {
                    window.ReactNativeWebView.postMessage('loaded');
                  }
                  
                  true;
                })();
              `}
              onMessage={() => {}}
            />
          )}
        </View>
      </Pressable>
    </View>
  );
}

