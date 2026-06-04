import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  Presentation,
  AlertTriangle,
  CheckCircle2,
  Maximize2,
} from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { useThread } from '@/lib/chat/hooks';
import { PresentationSlideCard } from './PresentationSlideCard';
import { FullScreenPresentationViewer } from './FullScreenPresentationViewer';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
import { getToolMetadata } from '../tool-metadata';
import { KortixLoader } from '@/components/ui';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';

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

// Utility functions
function formatTimestamp(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString();
  } catch (e) {
    return 'Invalid date';
  }
}

export function PresentationToolView({
  toolCall,
  toolResult,
  toolMessage,
  assistantMessage,
  isSuccess = true,
  isStreaming = false,
  project,
  assistantTimestamp,
  toolTimestamp,
}: ToolViewProps) {
  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  const toolName = toolCall.function_name;
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const threadId = toolMessage?.thread_id || assistantMessage?.thread_id;
  const { data: thread } = useThread(threadId);

  const effectiveProject = project || thread?.project;
  const sandboxUrl = (effectiveProject as any)?.sandbox?.sandbox_url;

  const [metadata, setMetadata] = useState<PresentationMetadata | null>(null);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasLoadedRef = useRef(false);

  const metadataCacheRef = useRef<Map<string, PresentationMetadata>>(new Map());
  const lastPresentationNameRef = useRef<string | null>(null);

  const [fullScreenVisible, setFullScreenVisible] = useState(false);
  const [fullScreenInitialSlide, setFullScreenInitialSlide] = useState(1);

  // Extract presentation info from toolResult.output
  let extractedPresentationName: string | undefined;
  let currentSlideNumber: number | undefined;
  let presentationTitle: string | undefined;
  let toolExecutionError: string | undefined;
  let toolMessageText: string | undefined;

  if (toolResult?.output) {
    try {
      let output = toolResult.output;

      if (typeof output === 'string') {
        if (output.startsWith('Error') || output.includes('exec')) {
          toolExecutionError = output;
        } else {
          try {
            output = JSON.parse(output);
          } catch {
            toolMessageText = output;
          }
        }
      }

      if (output && typeof output === 'object' && !toolExecutionError) {
        extractedPresentationName = output.presentation_name;
        currentSlideNumber = output.slide_number;
        presentationTitle = output.presentation_title || output.title;
        toolMessageText = output.message;
      }
    } catch (e) {
      toolExecutionError = `Error: ${String(e)}`;
    }
  }

  let args: Record<string, any> = {};
  if (toolCall.arguments) {
    if (typeof toolCall.arguments === 'object' && toolCall.arguments !== null) {
      args = toolCall.arguments;
    } else if (typeof toolCall.arguments === 'string') {
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        args = {};
      }
    }
  }

  const presentation_name = extractedPresentationName || args.presentation_name || args.presentationName || null;
  const title = presentationTitle || args.title || null;
  const message = toolMessageText || null;

  const displayTitle = metadata?.title || title || 'Presentation';

  // Handle list_slides output
  let slidesFromOutput: any[] = [];
  if (toolName === 'list_slides' && toolResult?.output && typeof toolResult.output === 'object') {
    const rawSlides = (toolResult.output as any).slides || [];
    slidesFromOutput = rawSlides.map((slide: any) => ({
      number: slide.slide_number,
      title: slide.title,
      filename: slide.filename,
      file_path: slide.preview_url || slide.file_path,
      preview_url: slide.preview_url,
      created_at: slide.created_at
    }));
  }

  const slides = useMemo(() => {
    if (metadata) {
      return Object.entries(metadata.slides)
        .map(([num, slide]) => ({ number: parseInt(num), ...slide }))
        .sort((a, b) => a.number - b.number);
    }
    return slidesFromOutput;
  }, [metadata, slidesFromOutput]);

  const slideCount = slides.length;

  // Load metadata with caching
  const loadMetadata = useCallback(async (retryCount = 0, forceRefresh = false) => {
    if (!presentation_name || !sandboxUrl || isStreaming) {
      setIsLoadingMetadata(false);
      return;
    }

    const sanitizedPresentationName = sanitizeFilename(presentation_name);
    const cachedMetadata = metadataCacheRef.current.get(sanitizedPresentationName);

    if (cachedMetadata && !forceRefresh) {
      setMetadata(cachedMetadata);
      setIsLoadingMetadata(false);
      hasLoadedRef.current = true;
      loadMetadata(0, true);
      return;
    }

    if (!cachedMetadata) {
      setIsLoadingMetadata(true);
    }
    setError(null);
    setRetryAttempt(retryCount);

    try {
      const metadataUrl = constructHtmlPreviewUrl(
        sandboxUrl,
        `presentations/${sanitizedPresentationName}/metadata.json`
      );
      const urlWithCacheBust = `${metadataUrl}?t=${Date.now()}`;

      const response = await fetch(urlWithCacheBust, {
        cache: 'no-cache',
        headers: { 'Cache-Control': 'no-cache' }
      });

      if (response.ok) {
        const data = await response.json();
        metadataCacheRef.current.set(sanitizedPresentationName, data);
        setMetadata(data);
        hasLoadedRef.current = true;
        setIsLoadingMetadata(false);

        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = null;
        }
        return;
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      if (cachedMetadata) {
        setIsLoadingMetadata(false);
      }

      const delay = retryCount < 5
        ? Math.min(1000 * Math.pow(2, retryCount), 10000)
        : 5000;

      retryTimeoutRef.current = setTimeout(() => {
        loadMetadata(retryCount + 1, forceRefresh);
      }, delay) as any;
    }
  }, [presentation_name, sandboxUrl, isStreaming]);

  useEffect(() => {
    const sanitizedName = presentation_name ? sanitizeFilename(presentation_name) : null;
    const presentationChanged = sanitizedName !== lastPresentationNameRef.current;

    if (presentationChanged) {
      hasLoadedRef.current = false;
      lastPresentationNameRef.current = sanitizedName;
    }

    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }

    if (presentation_name && sandboxUrl && !isStreaming) {
      loadMetadata(0);
    } else if (presentation_name && !sandboxUrl) {
      const hasCachedData = sanitizedName && metadataCacheRef.current.has(sanitizedName);
      if (!hasCachedData) {
        setIsLoadingMetadata(true);
      }
    } else {
      setIsLoadingMetadata(false);
    }

    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, [presentation_name, sandboxUrl, isStreaming, loadMetadata]);

  const handleFullScreenClick = useCallback((slideNumber: number) => {
    setFullScreenInitialSlide(slideNumber);
    setFullScreenVisible(true);
  }, []);

  const handleOpenPresentation = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setFullScreenInitialSlide(currentSlideNumber || 1);
    setFullScreenVisible(true);
  }, [currentSlideNumber]);

  const handleFullScreenClose = useCallback(() => {
    setFullScreenVisible(false);
  }, []);

  // For validate_slide
  const isValidateSlide = toolName === 'validate_slide';
  const validationPassed = toolResult?.output?.validation_passed;

  if (isValidateSlide && !isStreaming) {
    return (
      <ToolViewCard
        header={{
          icon: toolMetadata.icon,
          iconColor: toolMetadata.iconColor,
          iconBgColor: toolMetadata.iconBgColor,
          subtitle: toolMetadata.subtitle.toUpperCase(),
          title: toolMetadata.title,
          isSuccess: validationPassed !== false,
          isStreaming: false,
          rightContent: (
            <StatusBadge
              variant={validationPassed !== false ? 'success' : 'error'}
              label={validationPassed !== false ? 'Validated' : 'Failed'}
            />
          ),
        }}
      >
        <View className="flex-1 w-full items-center justify-center py-12 px-6">
          <View 
            className="rounded-2xl items-center justify-center mb-4" 
            style={{ 
              width: 64, 
              height: 64,
              backgroundColor: isDark 
                ? (validationPassed ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)')
                : (validationPassed ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)'),
            }}
          >
            <Icon 
              as={validationPassed ? CheckCircle2 : AlertTriangle} 
              size={32} 
              className={validationPassed ? 'text-primary' : 'text-destructive'} 
            />
          </View>
          <Text className="text-base font-roobert-medium text-foreground mb-2 text-center">
            {validationPassed ? 'Slide Validated' : 'Validation Failed'}
          </Text>
          {message && (
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              {message}
            </Text>
          )}
        </View>
      </ToolViewCard>
    );
  }

  // Loading state
  if (isStreaming || (isLoadingMetadata && !metadata && slidesFromOutput.length === 0)) {
    return (
      <ToolViewCard
        header={{
          icon: toolMetadata.icon,
          iconColor: toolMetadata.iconColor,
          iconBgColor: toolMetadata.iconBgColor,
          subtitle: toolMetadata.subtitle.toUpperCase(),
          title: toolMetadata.title,
          isSuccess: actualIsSuccess,
          isStreaming: true,
          rightContent: <StatusBadge variant="streaming" label="Processing" />,
        }}
      >
        <View className="flex-1 w-full items-center justify-center py-12 px-6">
          <KortixLoader size="large" />
          <Text className="text-lg font-roobert-semibold text-foreground mb-2 mt-6">
            {isStreaming ? 'Creating Slide...' : 'Loading Presentation'}
          </Text>
          <Text className="text-sm font-roobert text-muted-foreground text-center">
            {isStreaming
              ? 'Your slide is being created'
              : retryAttempt > 0
                ? `Fetching slides... (${retryAttempt + 1})`
                : 'Fetching slides...'}
          </Text>
        </View>
      </ToolViewCard>
    );
  }

  return (
    <ToolViewCard
      header={{
        icon: toolMetadata.icon,
        iconColor: toolMetadata.iconColor,
        iconBgColor: toolMetadata.iconBgColor,
        subtitle: toolMetadata.subtitle.toUpperCase(),
        title: toolMetadata.title,
        isSuccess: actualIsSuccess,
        isStreaming: false,
        rightContent: (
          <StatusBadge
            variant={actualIsSuccess ? 'success' : 'error'}
            label={slideCount > 0 ? `${slideCount} slide${slideCount !== 1 ? 's' : ''}` : actualIsSuccess ? 'Success' : 'Failed'}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {displayTitle && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
              {displayTitle}
            </Text>
          )}
          {(toolTimestamp || assistantTimestamp) && (
            <Text className="text-xs text-muted-foreground ml-2">
              {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
            </Text>
          )}
        </View>
      }
    >
      <View className="flex-1">
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          <View className="px-4 gap-4 py-4">
            {error ? (
              <View className="py-8 items-center">
                <View 
                  className="rounded-2xl items-center justify-center mb-4" 
                  style={{ 
                    width: 64, 
                    height: 64,
                    backgroundColor: isDark ? 'rgba(239, 68, 68, 0.15)' : 'rgba(239, 68, 68, 0.1)',
                  }}
                >
                  <Icon as={AlertTriangle} size={32} className="text-destructive" />
                </View>
                <Text className="text-base font-roobert-medium text-foreground mb-1">
                  Failed to Load
                </Text>
                <Text className="text-sm font-roobert text-muted-foreground text-center">
                  {error}
                </Text>
              </View>
            ) : slideCount === 0 ? (
              <View className="py-8 items-center">
                <View 
                  className="rounded-2xl items-center justify-center mb-4" 
                  style={{ 
                    width: 64, 
                    height: 64,
                    backgroundColor: isDark ? 'rgba(34, 197, 94, 0.15)' : 'rgba(34, 197, 94, 0.1)',
                  }}
                >
                  <Icon as={CheckCircle2} size={32} className="text-primary" />
                </View>
                <Text className="text-base font-roobert-medium text-foreground mb-2">
                  {toolName === 'create_slide' ? 'Slide Created' : 'No Slides Yet'}
                </Text>
                {toolName === 'create_slide' && currentSlideNumber && (
                  <Text className="text-sm font-roobert text-muted-foreground">
                    Slide {currentSlideNumber}
                  </Text>
                )}
              </View>
            ) : (
              <>
                {/* Open Presentation Button */}
                <Pressable
                  onPress={handleOpenPresentation}
                  className="flex-row items-center justify-center gap-2 py-3 rounded-xl active:opacity-70"
                  style={{
                    backgroundColor: isDark ? 'rgba(248, 248, 248, 0.08)' : 'rgba(18, 18, 21, 0.04)',
                    borderWidth: 1,
                    borderColor: isDark ? 'rgba(248, 248, 248, 0.12)' : 'rgba(18, 18, 21, 0.08)',
                  }}
                >
                  <Icon as={Maximize2} size={18} className="text-foreground" />
                  <Text className="text-sm font-roobert-medium text-foreground">
                    Open Presentation
                  </Text>
                </Pressable>

                {/* Slides */}
                <View className="gap-3">
                  {slides.map((slide) => (
                    <PresentationSlideCard
                      key={slide.number}
                      slide={slide}
                      sandboxUrl={sandboxUrl}
                      onFullScreenClick={handleFullScreenClick}
                      refreshTimestamp={metadata?.updated_at ? new Date(metadata.updated_at).getTime() : undefined}
                      isCurrentSlide={currentSlideNumber === slide.number}
                    />
                  ))}
                </View>
              </>
            )}
          </View>
        </ScrollView>
      </View>

      {/* Full Screen Viewer */}
      <FullScreenPresentationViewer
        visible={fullScreenVisible}
        onClose={handleFullScreenClose}
        presentationName={presentation_name}
        sandboxUrl={sandboxUrl}
        initialSlide={fullScreenInitialSlide}
      />
    </ToolViewCard>
  );
}
