import React from 'react';
import { View, Pressable } from 'react-native';
import { WebView } from 'react-native-webview';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Presentation } from 'lucide-react-native';

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
}

export function PresentationSlideCard({
  slide,
  sandboxUrl,
  className = '',
  refreshTimestamp,
}: PresentationSlideCardProps) {
  const slidePreviewUrl = React.useMemo(() => {
    if (!sandboxUrl) return null;
    const url = constructHtmlPreviewUrl(sandboxUrl, slide.file_path);
    return refreshTimestamp ? `${url}?t=${refreshTimestamp}` : url;
  }, [sandboxUrl, slide.file_path, refreshTimestamp]);

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

  return (
    <View className={`gap-2 ${className}`}>
      {/* Slide Title */}
      {slide.title && (
        <Text className="text-sm font-roobert-medium text-foreground px-1">
          {slide.title}
        </Text>
      )}

      {/* Slide Preview Container */}
      <View
        className="bg-white border border-border rounded-2xl overflow-hidden"
        style={{ aspectRatio: 16 / 9 }}
      >
        <WebView
          key={`slide-${slide.number}-${refreshTimestamp || slide.file_path}`}
          source={{ uri: slidePreviewUrl }}
          scrollEnabled={false}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          style={{ flex: 1, backgroundColor: 'white' }}
          originWhitelist={['*']}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
          scalesPageToFit={true}
          injectedJavaScript={`
            (function() {
              const existingViewport = document.querySelector('meta[name="viewport"]');
              if (existingViewport) {
                existingViewport.remove();
              }
              
              const viewport = document.createElement('meta');
              viewport.name = 'viewport';
              viewport.content = 'width=1200, initial-scale=0.2, maximum-scale=1.0, user-scalable=no';
              document.head.appendChild(viewport);
              
              const styleId = 'presentation-slide-scale-style';
              let style = document.getElementById(styleId);
              if (!style) {
                style = document.createElement('style');
                style.id = styleId;
                document.head.appendChild(style);
              }
              style.textContent = \`
                * {
                  box-sizing: border-box;
                }
                html, body {
                  margin: 0;
                  padding: 0;
                  width: 100%;
                  height: 100%;
                  overflow: hidden;
                }
                body {
                  display: flex;
                  align-items: center;
                  justify-content: center;
                }
                body > * {
                  width: 100%;
                  height: 100%;
                  object-fit: contain;
                }
              \`;
              
              true;
            })();
          `}
          onMessage={() => { }}
        />
      </View>
    </View>
  );
}

