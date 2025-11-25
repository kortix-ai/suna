import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, ScrollView, useColorScheme } from 'react-native';
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
import { useThread } from '@/lib/chat/hooks';
import { PresentationSlideCard } from './PresentationSlideCard';

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
  toolCall,
  toolResult,
  toolMessage,
  assistantMessage,
  isSuccess = true,
  isStreaming = false,
  project
}: ToolViewProps) {
  if (!toolCall) {
    return null;
  }

  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const threadId = toolMessage?.thread_id || assistantMessage?.thread_id;
  const { data: thread } = useThread(threadId);
  
  // Prefer project prop, fallback to thread project
  const effectiveProject = project || thread?.project;
  const sandboxUrl = effectiveProject?.sandbox?.sandbox_url;

  const [metadata, setMetadata] = useState<PresentationMetadata | null>(null);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasLoadedRef = useRef(false);

  // Extract presentation info from toolResult.output (matching desktop implementation)
  let extractedPresentationName: string | undefined;
  let extractedPresentationPath: string | undefined;
  let currentSlideNumber: number | undefined;
  let presentationTitle: string | undefined;
  let toolExecutionError: string | undefined;
  let toolMessageText: string | undefined;

  if (toolResult?.output) {
    try {
      let output = toolResult.output;
      
      // Handle string output
      if (typeof output === 'string') {
        // Check if the string looks like an error message
        if (output.startsWith('Error') || output.includes('exec')) {
          console.error('Tool execution error:', output);
          toolExecutionError = output;
        } else {
          // Try to parse as JSON
          try {
            output = JSON.parse(output);
          } catch (parseError) {
            console.error('Failed to parse tool output as JSON:', parseError);
            console.error('Raw tool output:', output);
            toolMessageText = output; // Keep as message text
          }
        }
      }
      
      // Only extract data if we have a valid parsed object
      if (output && typeof output === 'object' && !toolExecutionError) {
        extractedPresentationName = output.presentation_name;
        extractedPresentationPath = output.presentation_path;
        currentSlideNumber = output.slide_number;
        presentationTitle = output.presentation_title || output.title;
        toolMessageText = output.message;
      }
    } catch (e) {
      console.error('Failed to process tool output:', e);
      console.error('Tool output type:', typeof toolResult.output);
      console.error('Tool output value:', toolResult.output);
      toolExecutionError = `Unexpected error processing tool output: ${String(e)}`;
    }
  }

  // Extract from toolCall arguments as fallback
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

  // Use extracted name or fallback to args
  const presentation_name = extractedPresentationName || args.presentation_name || args.presentationName || null;
  const title = presentationTitle || args.title || null;
  const message = toolMessageText || null;
  const success = toolResult?.success !== false && isSuccess;

  const displayTitle = metadata?.title || title || 'Presentation';

  const slides = metadata ? Object.entries(metadata.slides)
    .map(([num, slide]) => ({ number: parseInt(num), ...slide }))
    .sort((a, b) => a.number - b.number) : [];

  const slideCount = slides.length;

  // Load metadata.json for the presentation with retry logic (matching desktop)
  const loadMetadata = useCallback(async (retryCount = 0, maxRetries = Infinity) => {
    // Don't load if we already successfully loaded metadata
    if (hasLoadedRef.current) {
      return;
    }
    
    // If sandbox URL isn't available yet, wait and don't set loading state
    if (!presentation_name || !sandboxUrl || isStreaming) {
      setIsLoadingMetadata(false);
      return;
    }
    
    setIsLoadingMetadata(true);
    setError(null);
    setRetryAttempt(retryCount);
    
    try {
      // Sanitize the presentation name to match backend directory creation
      const sanitizedPresentationName = sanitizeFilename(presentation_name);
      
      const metadataUrl = constructHtmlPreviewUrl(
        sandboxUrl,
        `presentations/${sanitizedPresentationName}/metadata.json`
      );
      
      // Add cache-busting parameter to ensure fresh data
      const urlWithCacheBust = `${metadataUrl}?t=${Date.now()}`;
      
      console.log(`🎨 [PresentationToolView] Loading metadata (attempt ${retryCount + 1}):`, urlWithCacheBust);
      
      const response = await fetch(urlWithCacheBust, {
        cache: 'no-cache',
        headers: {
          'Cache-Control': 'no-cache'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        setMetadata(data);
        hasLoadedRef.current = true; // Mark as successfully loaded
        console.log('🎨 [PresentationToolView] Successfully loaded metadata:', data);
        setIsLoadingMetadata(false);
        
        // Clear any pending retry timeout on success
        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = null;
        }
        
        return; // Success, exit early
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (err) {
      console.error(`🎨 [PresentationToolView] Error loading metadata (attempt ${retryCount + 1}):`, err);
      
      // Calculate delay with exponential backoff, capped at 10 seconds
      // For early attempts, use shorter delays. After 5 attempts, use consistent 5 second intervals
      const delay = retryCount < 5 
        ? Math.min(1000 * Math.pow(2, retryCount), 10000) // Exponential backoff for first 5 attempts
        : 5000; // Consistent 5 second intervals after that
      
      console.log(`🎨 [PresentationToolView] Retrying in ${delay}ms... (attempt ${retryCount + 1})`);
      
      // Keep retrying indefinitely - don't set error state
      retryTimeoutRef.current = setTimeout(() => {
        loadMetadata(retryCount + 1, maxRetries);
      }, delay);
      
      return; // Keep loading state, don't set error
    }
  }, [presentation_name, sandboxUrl, isStreaming]);

  useEffect(() => {
    // Reset loaded flag when presentation name or sandbox URL changes
    hasLoadedRef.current = false;
    
    // Clear any existing retry timeout when dependencies change
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    
    if (presentation_name && sandboxUrl && !isStreaming) {
      loadMetadata(0);
    }
    
    // Cleanup on unmount
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, [presentation_name, sandboxUrl, isStreaming, loadMetadata]);

  console.log('🎨 [PresentationToolView] Display data:', {
    toolName: toolCall?.function_name,
    displayTitle,
    presentation_name,
    extractedPresentationName,
    hasMetadata: !!metadata,
    slideCount,
    isLoadingMetadata,
    retryAttempt,
    error,
    sandboxUrl
  });

  // Show loading state while streaming or loading metadata (with retry attempts)
  if (isStreaming || (isLoadingMetadata && !metadata)) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-primary/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Loader2} size={40} className="text-primary animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          {isStreaming ? 'Creating Slide...' : 'Loading Presentation'}
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          {isStreaming 
            ? 'Slide is being created...' 
            : retryAttempt > 0 
              ? `Fetching slides... (attempt ${retryAttempt + 1})`
              : 'Fetching slides...'}
        </Text>
        {message && !isStreaming && (
          <View className="mt-4 px-4 py-2 bg-muted/50 rounded-lg">
            <Text className="text-xs font-roobert text-muted-foreground text-center">
              {message}
            </Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Presentation} size={24} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Presentation
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              {displayTitle}
            </Text>
          </View>
        </View>

        {error ? (
          <View className="py-8 items-center">
            <View className="bg-destructive/10 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
              <Icon as={AlertTriangle} size={32} className="text-destructive" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              Failed to Load Presentation
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              {error}
            </Text>
          </View>
        ) : slideCount === 0 ? (
          <View className="py-8 items-center">
            <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
              <Icon as={Presentation} size={32} className="text-muted-foreground" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              {presentation_name ? 'No Slides Found Yet' : 'No Presentation Found'}
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center px-4">
              {message || (presentation_name 
                ? "Slides will appear here once they're created. The metadata file may still be generating."
                : "This presentation doesn't have any slides yet.")}
            </Text>
            {presentation_name && !sandboxUrl && (
              <Text className="text-xs font-roobert text-muted-foreground/60 text-center px-4 mt-2">
                Waiting for sandbox to be available...
              </Text>
            )}
          </View>
        ) : (
          <View className="gap-4">
            {slides.map((slide) => (
              <PresentationSlideCard
                key={slide.number}
                slide={slide}
                sandboxUrl={sandboxUrl}
                onFullScreenClick={(slideNumber) => {
                  // TODO: Implement full screen viewer for mobile
                  console.log('Open slide in full screen:', slideNumber);
                }}
                refreshTimestamp={metadata?.updated_at ? new Date(metadata.updated_at).getTime() : undefined}
              />
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

