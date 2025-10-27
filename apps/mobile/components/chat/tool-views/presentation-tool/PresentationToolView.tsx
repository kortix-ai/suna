import React, { useState, useEffect, useCallback } from 'react';
import { View, ScrollView, useColorScheme } from 'react-native';
import { WebView } from 'react-native-webview';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  Presentation, 
  Clock,
  CheckCircle, 
  AlertTriangle,
  Loader2,
  CheckCircle2
} from 'lucide-react-native';
import { cn } from '@/lib/utils';
import type { ToolViewProps } from '../types';
import { extractPresentationData } from './_utils';
import { useThread } from '@/lib/chat/hooks';

interface SlideMetadata {
  title: string;
  filename: string;
  file_path: string;
  preview_url: string;
  created_at: string;
}

interface PresentationMetadata {
  presentation_name: string;
  title: string;
  description: string;
  slides: Record<string, SlideMetadata>;
  created_at: string;
  updated_at: string;
}

const sanitizeFilename = (name: string): string => {
  return name.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
};

const constructHtmlPreviewUrl = (sandboxUrl: string, filePath: string): string => {
  const processedPath = filePath.replace(/^\/workspace\//, '');
  const pathSegments = processedPath.split('/').map(segment => encodeURIComponent(segment));
  const encodedPath = pathSegments.join('/');
  return `${sandboxUrl}/${encodedPath}`;
};

export function PresentationToolView({ 
  toolData, 
  toolMessage,
  assistantMessage,
  isStreaming = false 
}: ToolViewProps) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const threadId = toolMessage?.thread_id || assistantMessage?.thread_id;
  const { data: thread } = useThread(threadId);
  const sandboxUrl = thread?.project?.sandbox?.sandbox_url;
  
  const [metadata, setMetadata] = useState<PresentationMetadata | null>(null);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const extractedData = extractPresentationData(toolData);
  const { title, presentation_name, message, success } = extractedData;
  
  const displayTitle = metadata?.title || title || 'Presentation';
  
  const slides = metadata ? Object.entries(metadata.slides)
    .map(([num, slide]) => ({ number: parseInt(num), ...slide }))
    .sort((a, b) => a.number - b.number) : [];
  
  const slideCount = slides.length;

  const loadMetadata = useCallback(async () => {
    if (!presentation_name || !sandboxUrl || isStreaming) return;
    
    setIsLoadingMetadata(true);
    setError(null);
    
    try {
      const sanitizedName = sanitizeFilename(presentation_name);
      const metadataUrl = constructHtmlPreviewUrl(
        sandboxUrl,
        `presentations/${sanitizedName}/metadata.json`
      );
      
      const urlWithCacheBust = `${metadataUrl}?t=${Date.now()}`;
      
      console.log('🎨 [PresentationToolView] Loading metadata:', urlWithCacheBust);
      
      const response = await fetch(urlWithCacheBust, {
        cache: 'no-cache',
        headers: {
          'Cache-Control': 'no-cache'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        setMetadata(data);
        console.log('🎨 [PresentationToolView] Loaded metadata:', data);
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (err) {
      console.error('🎨 [PresentationToolView] Error loading metadata:', err);
      setError(err instanceof Error ? err.message : 'Failed to load presentation');
    } finally {
      setIsLoadingMetadata(false);
    }
  }, [presentation_name, sandboxUrl, isStreaming]);

  useEffect(() => {
    if (presentation_name && !isStreaming) {
      loadMetadata();
    }
  }, [presentation_name, isStreaming, loadMetadata]);

  console.log('🎨 [PresentationToolView] Display data:', {
    toolName: toolData?.toolName,
    displayTitle,
    presentation_name,
    hasMetadata: !!metadata,
    slideCount,
    isLoadingMetadata,
    error
  });

  if (isStreaming || (isLoadingMetadata && !metadata)) {
    return (
      <View className="flex flex-col overflow-hidden bg-card">
        <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Presentation} size={24} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              Presentation
            </Text>
          </View>
          {!isStreaming && (
            <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${
              success ? 'bg-primary/10' : 'bg-destructive/10'
            }`}>
              <Icon 
                as={success ? CheckCircle2 : AlertTriangle} 
                size={12} 
                className={success ? 'text-primary' : 'text-destructive'} 
              />
              <Text className={`text-xs font-roobert-medium ${
                success ? 'text-primary' : 'text-destructive'
              }`}>
                {success ? 'Success' : 'Failed'}
              </Text>
            </View>
          )}
        </View>
        </View>
        <View className="flex-col items-center justify-center py-12 px-6 flex-1">
          <View className="w-20 h-20 rounded-full items-center justify-center mb-6 bg-blue-100 dark:bg-blue-800/40">
            <Icon as={Loader2} size={40} className="text-blue-500 dark:text-blue-400" />
          </View>
          <Text className="text-xl font-roobert-semibold mb-2 text-zinc-900 dark:text-zinc-100">
            Loading Presentation
          </Text>
          <Text className="text-sm text-zinc-500 dark:text-zinc-400">
            Fetching slides...
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex flex-col overflow-hidden bg-card">
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="flex-row items-center gap-2 flex-1">
            <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
              <Icon as={Presentation} size={24} className="text-primary" />
            </View>
            <View className="flex-1">
              <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
                {displayTitle}
              </Text>
            </View>
          </View>
          {!isStreaming && (
            <View className={cn(
              "px-2 py-1 rounded-md flex-row items-center gap-1",
              success 
                ? "bg-emerald-100 dark:bg-emerald-900/30" 
                : "bg-rose-100 dark:bg-rose-900/30"
            )}>
              <Icon 
                as={success ? CheckCircle : AlertTriangle} 
                size={14} 
                className={success ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}
              />
              <Text className={cn(
                "text-xs font-roobert-medium",
                success 
                  ? "text-emerald-700 dark:text-emerald-300" 
                  : "text-rose-700 dark:text-rose-300"
              )}>
                {success ? 'Success' : 'Failed'}
              </Text>
            </View>
          )}
        </View>
      </View>

      <View className="flex-1">
        {error ? (
          <View className="flex-col items-center justify-center py-12 px-6">
            <View className="w-20 h-20 rounded-full items-center justify-center mb-6 bg-rose-100 dark:bg-rose-800/40">
              <Icon as={AlertTriangle} size={40} className="text-rose-400 dark:text-rose-600" />
            </View>
            <Text className="text-xl font-roobert-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              Failed to Load Presentation
            </Text>
            <Text className="text-sm text-zinc-500 dark:text-zinc-400 text-center">
              {error}
            </Text>
          </View>
        ) : slideCount === 0 ? (
          <View className="flex-col items-center justify-center py-12 px-6">
            <View className="w-20 h-20 rounded-full items-center justify-center mb-6 bg-blue-100 dark:bg-blue-800/40">
              <Icon as={Presentation} size={40} className="text-blue-400 dark:text-blue-600" />
            </View>
            <Text className="text-xl font-roobert-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No Slides Found
            </Text>
            <Text className="text-sm text-zinc-500 dark:text-zinc-400 text-center">
              {message || "This presentation doesn't have any slides yet."}
            </Text>
          </View>
        ) : (
          <ScrollView className="flex-1" contentContainerClassName="p-4">
            <View className="gap-4">
              {slides.map((slide) => {
                const slideUrl = sandboxUrl 
                  ? constructHtmlPreviewUrl(sandboxUrl, slide.file_path)
                  : null;
                const slideUrlWithCacheBust = slideUrl ? `${slideUrl}?t=${Date.now()}` : null;
                
                return (
                  <View 
                    key={slide.number} 
                    className="bg-background border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden"
                  >
                    <View className="px-3 py-2 bg-muted/20 border-b border-border/40 flex-row items-center justify-between">
                      <View className="flex-row items-center gap-2 flex-1">
                        <View className="h-6 px-2 rounded border border-border bg-background items-center justify-center">
                          <Text className="text-xs font-mono text-foreground">
                            #{slide.number}
                          </Text>
                        </View>
                        {slide.title && (
                          <Text className="text-sm text-muted-foreground flex-1" numberOfLines={1}>
                            {slide.title}
                          </Text>
                        )}
                      </View>
                    </View>
                    
                    <View className="bg-muted/30" style={{ aspectRatio: 16/9 }}>
                      {slideUrlWithCacheBust ? (
                        <WebView
                          source={{ uri: slideUrlWithCacheBust }}
                          scrollEnabled={false}
                          showsVerticalScrollIndicator={false}
                          showsHorizontalScrollIndicator={false}
                          style={{ flex: 1, backgroundColor: 'transparent' }}
                          originWhitelist={['*']}
                          javaScriptEnabled={true}
                          domStorageEnabled={true}
                        />
                      ) : (
                        <View className="flex-1 items-center justify-center">
                          <Text className="text-sm text-muted-foreground">
                            Unable to load slide
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        )}
      </View>
    </View>
  );
}

