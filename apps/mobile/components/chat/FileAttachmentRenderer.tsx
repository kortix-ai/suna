/**
 * File Attachment Renderer - Modular component for rendering uploaded files
 * 
 * Supports:
 * - Images (jpg, jpeg, png, gif, webp, svg)
 * - Documents (pdf, doc, docx, etc.)
 * - Presentations (renders slide preview card for presentations/[name]/slide_XX.html)
 * - HTML files (iframe preview)
 * - Other file types
 * 
 * Can be used in:
 * - Chat messages
 * - Tool outputs
 * - Any context where files need to be displayed
 */

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { View, Image, Pressable, ActivityIndicator, ScrollView, LayoutChangeEvent } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { FileText, File, Download, ExternalLink, Image as ImageIcon, Play } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { SelectableMarkdownText } from '@/components/ui/selectable-markdown';
import { autoLinkUrls } from '@agentpress/shared';
import {
  isImageExtension,
  isDocumentExtension,
  isPreviewableExtension,
  isJsonExtension,
  isMarkdownExtension,
  isHtmlExtension,
  isDocxExtension,
  isPdfExtension,
} from '@/lib/utils/file-types';
import { WebView } from 'react-native-webview';
import { getAuthToken } from '@/api/config';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { FullScreenPresentationViewer } from './tool-views/presentation-tool/FullScreenPresentationViewer';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Helper to check if a filepath is a presentation attachment
 * Matches: presentations/[name]/slide_XX.html (with or without /workspace/ prefix)
 */
function isPresentationAttachment(filepath: string): boolean {
  const presentationPattern = /presentations\/([^\/]+)\/(slide_\d+\.html|metadata\.json)$/i;
  return presentationPattern.test(filepath);
}

/**
 * Parse presentation slide path to extract name and slide number
 */
function parsePresentationSlidePath(filePath: string | null): {
  isValid: boolean;
  presentationName: string | null;
  slideNumber: number | null;
} {
  if (!filePath) {
    return { isValid: false, presentationName: null, slideNumber: null };
  }

  // Match presentations/[name]/slide_XX.html anywhere in the path (handles /workspace/ prefix)
  const match = filePath.match(/presentations\/([^\/]+)\/slide_(\d+)\.html$/i);
  if (match) {
    return {
      isValid: true,
      presentationName: match[1],
      slideNumber: parseInt(match[2], 10)
    };
  }

  return { isValid: false, presentationName: null, slideNumber: null };
}

/**
 * Construct HTML preview URL from sandbox URL
 * Handles paths with or without /workspace/ prefix
 */
function constructHtmlPreviewUrl(sandboxUrl: string, filePath: string): string {
  // Remove /workspace/ prefix if present, and any leading slashes
  const processedPath = filePath.replace(/^\/workspace\//, '').replace(/^\/+/, '');
  const pathSegments = processedPath.split('/').map(segment => encodeURIComponent(segment));
  const encodedPath = pathSegments.join('/');
  return `${sandboxUrl}/${encodedPath}`;
}

interface FileAttachment {
  path: string;
  type: 'image' | 'document' | 'other';
  name: string;
  extension?: string;
}

interface FileAttachmentRendererProps {
  /** File path from sandbox */
  filePath: string;
  /** Sandbox ID to construct download URL */
  sandboxId?: string;
  /** Sandbox URL for direct file access (used for presentations and HTML previews) */
  sandboxUrl?: string;
  /** Compact mode for smaller displays */
  compact?: boolean;
  /** Show filename */
  showName?: boolean;
  /** Show file preview */
  showPreview?: boolean;
  /** Custom onPress handler */
  onPress?: (filePath: string) => void;
}

/**
 * Parse file path and determine type using centralized file-types utility
 */
function parseFilePath(path: string): FileAttachment {
  const name = path.split('/').pop() || 'file';
  const extension = name.split('.').pop()?.toLowerCase() || '';

  let type: 'image' | 'document' | 'other' = 'other';

  if (isImageExtension(extension)) {
    type = 'image';
  } else if (isDocumentExtension(extension)) {
    type = 'document';
  }

  return { path, type, name, extension };
}

function normalizeSandboxWorkspacePath(inputPath: string): string {
  const raw = (inputPath || '').trim();
  if (!raw) return '/workspace/';
  // If it already looks like a workspace path, just ensure leading slash.
  if (raw.startsWith('/workspace/')) return raw;
  if (raw.startsWith('workspace/')) return `/${raw}`;

  // Ensure leading slash first.
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  // If it's not already under /workspace/, assume it's relative to the sandbox workspace.
  return withLeadingSlash.startsWith('/workspace/')
    ? withLeadingSlash
    : `/workspace${withLeadingSlash}`;
}

async function fetchOpenCodeFileContent(
  sandboxUrl: string,
  filePath: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<{ content: string; mimeType?: string; encoding?: string }> {
  const response = await fetch(
    `${sandboxUrl}/file/content?path=${encodeURIComponent(filePath)}`,
    {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${response.status}`);
  }

  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return {
      content: parsed.content ?? '',
      mimeType: parsed.mimeType,
      encoding: parsed.encoding,
    };
  } catch {
    return { content: text };
  }
}

async function fetchOpenCodeFileBlob(
  sandboxUrl: string,
  filePath: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<Blob> {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };

  try {
    const rawResponse = await fetch(
      `${sandboxUrl}/file/raw?path=${encodeURIComponent(filePath)}`,
      { headers, signal },
    );

    if (rawResponse.ok) {
      const contentType = rawResponse.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        return rawResponse.blob();
      }
    }
  } catch (error) {
    if ((error as any)?.name === 'AbortError') throw error;
  }

  const data = await fetchOpenCodeFileContent(sandboxUrl, filePath, token, signal);
  if (data.encoding === 'base64' && data.content) {
    const binary = atob(data.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: data.mimeType || 'application/octet-stream' });
  }

  return new Blob([data.content || ''], { type: data.mimeType || 'text/plain' });
}

/**
 * Main File Attachment Renderer Component
 */
export function FileAttachmentRenderer({
  filePath,
  sandboxUrl,
  compact = false,
  showName = true,
  showPreview = false,
  onPress,
}: FileAttachmentRendererProps) {
  const file = useMemo(() => parseFilePath(filePath), [filePath]);

  // Check if this is a presentation attachment - render with PresentationSlideCard
  const presentationParsed = useMemo(() => parsePresentationSlidePath(filePath), [filePath]);

  if (presentationParsed.isValid && sandboxUrl && presentationParsed.presentationName && presentationParsed.slideNumber) {
    return (
      <PresentationAttachment
        presentationName={presentationParsed.presentationName}
        slideNumber={presentationParsed.slideNumber}
        filePath={filePath}
        sandboxUrl={sandboxUrl}
      />
    );
  }

  // Check if this is an HTML file that should use iframe preview (when sandboxUrl is available)
  // BUT: exclude presentation slides - they should be handled by PresentationAttachment above
  const isHtmlFile = file.extension === 'html' || file.extension === 'htm';
  const isPresentationSlide = isPresentationAttachment(filePath);
  if (isHtmlFile && sandboxUrl && showPreview && !isPresentationSlide) {
    return (
      <HtmlPreviewAttachment
        file={file}
        sandboxUrl={sandboxUrl}
        onPress={onPress}
      />
    );
  }

  switch (file.type) {
    case 'image':
      return (
        <ImageAttachment
          file={file}
          sandboxUrl={sandboxUrl}
          compact={compact}
          showName={showName}
          showPreview={showPreview}
          onPress={onPress}
        />
      );
    case 'document':
      return (
        <DocumentAttachment
          file={file}
          compact={compact}
          showPreview={showPreview}
          sandboxUrl={sandboxUrl}
          onPress={onPress}
        />
      );
    default:
      return (
        <GenericAttachment
          file={file}
          compact={compact}
          onPress={onPress}
        />
      );
  }
}

/**
 * Image Attachment Component
 */
function ImageAttachment({
  file,
  sandboxUrl,
  compact,
  showName,
  showPreview,
  onPress,
}: {
  file: FileAttachment;
  sandboxUrl?: string;
  compact: boolean;
  showName: boolean;
  showPreview: boolean;
  onPress?: (path: string) => void;
}) {
  const { colorScheme } = useColorScheme();
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const scale = useSharedValue(1);

  const [blobUrl, setBlobUrl] = useState<string | undefined>();

  useEffect(() => {
    let isCancelled = false;
    const abortController = new AbortController();
    let retryCount = 0;
    const MAX_RETRIES = 3;

    const run = async () => {
      setHasError(false);
      setIsLoading(true);

      log.log('[ImageAttachment] Starting image load:', {
        filePath: file.path,
        fileType: file.type,
        fileExtension: file.extension,
        sandboxUrl,
        showPreview,
      });

      // For uploaded files (in /workspace/uploads), we need the sandbox URL.
      const isUploadedFile = file.path.includes('/uploads/') || file.path.includes('/workspace');
      if (!sandboxUrl && isUploadedFile) {
        log.log('[ImageAttachment] Waiting for sandboxUrl for uploaded file...');
        setIsLoading(true);
        return;
      }

      // Non-sandbox, non-uploaded images can render directly (e.g., external URLs)
      if (!sandboxUrl && !isUploadedFile) {
        log.log('[ImageAttachment] Non-sandbox image, using direct path');
        setBlobUrl(file.path);
        setIsLoading(false);
        return;
      }

      // If we already have a blob URL for this sandbox URL, don't refetch.
      if (blobUrl && blobUrl.startsWith('data:')) {
        log.log('[ImageAttachment] Already have blob URL, skipping fetch');
        return;
      }

      const normalizedPath = normalizeSandboxWorkspacePath(file.path);

      log.log('[ImageAttachment] Fetching sandbox image:', {
        file,
        originalPath: file.path,
        normalizedPath,
        sandboxUrl,
      });

      try {
        const token = await getAuthToken();
        if (!sandboxUrl) throw new Error('Sandbox URL required');
        const blob = await fetchOpenCodeFileBlob(sandboxUrl, normalizedPath, token, abortController.signal);
        log.log('[ImageAttachment] ✅ Blob received:', {
          size: blob.size,
          type: blob.type,
          normalizedPath,
        });

        const { blobToDataURL } = await import('@/lib/files/hooks');
        const dataUrl = await blobToDataURL(blob, file.path);
        log.log('[ImageAttachment] ✅ Data URL created successfully, mime fixed for:', file.extension);
        if (!isCancelled) {
          setBlobUrl(dataUrl);
          setIsLoading(false);
        }
      } catch (error) {
        // Abort is expected on unmount; don't treat as an error.
        if ((error as any)?.name === 'AbortError') {
          log.log('[ImageAttachment] Fetch aborted (component unmounted)');
          return;
        }

        log.error('[ImageAttachment] ❌ Network error fetching image:', {
          error,
          errorMessage: (error as any)?.message,
          normalizedPath,
          sandboxUrl,
          file,
          retryCount,
        });

        // Retry on network errors (timeout, connection failed, etc.)
        if (retryCount < MAX_RETRIES && !isCancelled) {
          retryCount++;
          const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 5000); // Exponential backoff
          log.log(`[ImageAttachment] 🔄 Retrying after network error in ${delay}ms (attempt ${retryCount}/${MAX_RETRIES})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          if (!isCancelled) {
            return run(); // Retry
          }
        }

        if (!isCancelled) {
          setHasError(true);
          setIsLoading(false);
        }
      }
    };

    run();
    return () => {
      isCancelled = true;
      abortController.abort();
    };
  }, [sandboxUrl, file.path]);

  // Reset blob URL when sandboxUrl changes (sandbox becomes available)
  useEffect(() => {
    if (sandboxUrl && blobUrl && !blobUrl.startsWith('data:')) {
      log.log('[ImageAttachment] Sandbox URL changed, resetting blob URL to refetch');
      setBlobUrl(undefined);
    }
  }, [sandboxUrl]);

  const imageUrl = blobUrl || file.path;

  // For sandbox images, wait for blob URL before rendering
  const shouldWaitForBlob = sandboxUrl && !blobUrl && !hasError;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    if (onPress) {
      onPress(file.path);
    }
  };

  const containerWidth = showPreview ? '100%' : (compact ? 120 : 200);
  const containerHeight = showPreview ? 240 : (compact ? 120 : 200);

  return (
    <View className="mb-2" style={{ width: showPreview ? '100%' : undefined }}>
      <AnimatedPressable
        onPressIn={() => {
          scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          scale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        onPress={handlePress}
        style={[animatedStyle, showPreview ? { width: '100%' } : undefined]}
        className="rounded-3xl overflow-hidden border border-border bg-card"
      >
        <View style={{ width: showPreview ? '100%' : containerWidth, height: containerHeight }}>
          {!hasError && !shouldWaitForBlob ? (
            <>
              <Image
                source={{ uri: imageUrl }}
                style={{ width: '100%', height: '100%' }}
                resizeMode="cover"
                onLoadEnd={() => {
                  log.log('[ImageAttachment] Image loaded successfully');
                  setIsLoading(false);
                }}
                onError={(error) => {
                  log.error('[ImageAttachment] Image onError:', error.nativeEvent);
                  setIsLoading(false);
                  setHasError(true);
                }}
              />

              {/* Only show spinner for network URLs, not data URLs (which load instantly) */}
              {isLoading && imageUrl && !imageUrl.startsWith('data:') && (
                <View className="absolute inset-0 bg-muted/50 items-center justify-center">
                  <ActivityIndicator
                    size="small"
                    color={colorScheme === 'dark' ? '#ffffff' : '#000000'}
                  />
                </View>
              )}
            </>
          ) : shouldWaitForBlob ? (
            <View className="flex-1 items-center justify-center bg-muted/30">
              <ActivityIndicator
                size="small"
                color={colorScheme === 'dark' ? '#ffffff' : '#000000'}
              />
              <Text className="text-xs text-muted-foreground mt-2">
                Loading...
              </Text>
            </View>
          ) : (
            <Pressable
              onPress={() => {
                log.log('[ImageAttachment] Manual retry triggered');
                setHasError(false);
                setBlobUrl(undefined); // Reset to trigger refetch
              }}
              className="flex-1 items-center justify-center bg-muted/30"
            >
              <Icon
                as={ImageIcon}
                size={32}
                className="text-muted-foreground mb-2"
                strokeWidth={1.5}
              />
              <Text className="text-xs text-muted-foreground mb-1">
                Failed to load
              </Text>
              <Text className="text-[10px] text-primary font-medium">
                Tap to retry
              </Text>
            </Pressable>
          )}
        </View>

        {/* Image overlay with icon */}
        {!isLoading && !hasError && (
          <View className="absolute top-2 right-2 bg-black/50 rounded-full p-1.5">
            <Icon
              as={ExternalLink}
              size={12}
              className="text-white"
              strokeWidth={2}
            />
          </View>
        )}
      </AnimatedPressable>

      {showName && !showPreview && (
        <Text
          className="text-xs text-muted-foreground mt-1.5 font-roobert"
          numberOfLines={1}
          style={{ width: typeof containerWidth === 'number' ? containerWidth : undefined }}
        >
          {file.name}
        </Text>
      )}
    </View>
  );
}

/**
 * Document Attachment Component
 */
function DocumentAttachment({
  file,
  compact,
  showPreview,
  sandboxUrl,
  onPress,
}: {
  file: FileAttachment;
  compact: boolean;
  showPreview: boolean;
  sandboxUrl?: string;
  onPress?: (path: string) => void;
}) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [docxBlobUrl, setDocxBlobUrl] = useState<string | null>(null);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    if (onPress) {
      onPress(file.path);
    }
  };

  const ext = file.extension?.toLowerCase() || '';
  const isDocx = isDocxExtension(ext);
  const isPdf = isPdfExtension(ext);

  const isPreviewable = useMemo(() => {
    if (!showPreview || !file.extension) return false;
    const ext = file.extension.toLowerCase();
    // Don't preview presentation slides - they should use PresentationAttachment instead
    if (isHtmlExtension(ext) && isPresentationAttachment(file.path)) {
      return false;
    }
    return isPreviewableExtension(ext);
  }, [showPreview, file.extension, file.path]);

  useEffect(() => {
    if (isPreviewable && sandboxUrl) {
      setIsLoading(true);
      setHasError(false);

      const fetchFileContent = async () => {
        try {
          const token = await getAuthToken();

          let filePath = file.path;
          if (!filePath.startsWith('/')) {
            filePath = '/workspace/' + filePath;
          }

          // DOCX and PDF files need to be fetched as blob
          if (isDocx || isPdf) {
            const blob = await fetchOpenCodeFileBlob(sandboxUrl, filePath, token);
            // Convert blob to base64 data URL
            const reader = new FileReader();
            reader.onloadend = () => {
              const base64 = reader.result as string;
              if (isDocx) {
                log.log('[DocumentAttachment] DOCX blob converted to base64, length:', base64.length);
                setDocxBlobUrl(base64);
              } else if (isPdf) {
                log.log('[DocumentAttachment] PDF blob converted to base64, length:', base64.length);
                setPdfBlobUrl(base64);
              }
              setIsLoading(false);
            };
            reader.onerror = () => {
              log.error('[DocumentAttachment] Failed to read blob');
              setHasError(true);
              setIsLoading(false);
            };
            reader.readAsDataURL(blob);
            return;
          }

          // Text-based files
          const data = await fetchOpenCodeFileContent(sandboxUrl, filePath, token);
          const content = data.encoding === 'base64' && data.content
            ? atob(data.content)
            : data.content;
          log.log('[DocumentAttachment] Fetched content length:', content.length);
          setFileContent(content);
        } catch (error) {
          log.error('[DocumentAttachment] Failed to fetch file content:', error);
          setHasError(true);
        } finally {
          if (!isDocx && !isPdf) {
            setIsLoading(false);
          }
        }
      };

      fetchFileContent();
    }
  }, [isPreviewable, sandboxUrl, file.path, isDocx, isPdf]);

  if (showPreview && isPreviewable) {
    const ext = file.extension?.toLowerCase() || '';
    const isMarkdown = isMarkdownExtension(ext);
    const isJson = isJsonExtension(ext);
    const isHtml = isHtmlExtension(ext);

    log.log('[DocumentAttachment] Render state:', {
      isLoading,
      hasError,
      hasFileContent: !!fileContent,
      contentLength: fileContent?.length || 0,
      ext,
      isMarkdown,
      isHtml,
      path: file.path,
    });

    return (
      <View className="mb-3 rounded-2xl overflow-hidden border border-border bg-card" style={{ width: '100%' }}>
        <Pressable onPress={handlePress} className="border-b border-border bg-neutral-200 dark:bg-neutral-800 px-4 py-3">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <Icon as={FileText} size={16} className="text-muted-foreground" />
              <Text className="text-sm font-roobert-medium text-foreground" numberOfLines={1}>
                {file.name}
              </Text>
            </View>
            <Icon as={ExternalLink} size={14} className="text-muted-foreground" />
          </View>
        </Pressable>

        <View className="bg-background" style={{ height: 400 }}>
          {isLoading ? (
            <View className="flex-1 items-center justify-center p-8">
              <ActivityIndicator size="small" color={colorScheme === 'dark' ? '#ffffff' : '#000000'} />
              <Text className="text-xs text-muted-foreground mt-2">Loading preview...</Text>
            </View>
          ) : hasError ? (
            <View className="flex-1 items-center justify-center p-8">
              <Icon as={FileText} size={32} className="text-muted-foreground mb-2" />
              <Text className="text-xs text-muted-foreground">Failed to load preview</Text>
              <Pressable onPress={handlePress} className="mt-3 px-4 py-2 bg-primary/10 rounded-full">
                <Text className="text-xs text-primary font-medium">Open file</Text>
              </Pressable>
            </View>
          ) : (isDocx && docxBlobUrl) || (isPdf && pdfBlobUrl) ? (
            <View className="flex-1 items-center justify-center p-8">
              <Icon as={FileText} size={32} className="text-muted-foreground mb-2" />
              <Text className="text-xs text-muted-foreground text-center">
                Preview disabled for this file type
              </Text>
              <Pressable onPress={handlePress} className="mt-3 px-4 py-2 bg-primary/10 rounded-full">
                <Text className="text-xs text-primary font-medium">Open file</Text>
              </Pressable>
            </View>
          ) : fileContent ? (
            isHtml ? (
              <WebView
                source={sandboxUrl ? { uri: constructHtmlPreviewUrl(sandboxUrl, file.path) } : { html: fileContent }}
                style={{ width: '100%', height: 400 }}
                scrollEnabled={true}
                originWhitelist={['*']}
                javaScriptEnabled={false}
                domStorageEnabled={false}
              />
            ) : (
              <ScrollView className="p-4" style={{ height: 400 }} showsVerticalScrollIndicator={true}>
                {isMarkdown ? (
                  <SelectableMarkdownText isDark={colorScheme === 'dark'}>
                    {autoLinkUrls(fileContent)}
                  </SelectableMarkdownText>
                ) : isJson ? (
                  <Text className="text-xs font-mono text-foreground leading-5" selectable style={{ fontFamily: 'monospace' }}>
                    {(() => {
                      try {
                        const parsed = JSON.parse(fileContent);
                        return JSON.stringify(parsed, null, 2);
                      } catch {
                        return fileContent;
                      }
                    })()}
                  </Text>
                ) : (
                  <Text className="text-xs font-mono text-foreground leading-5" selectable style={{ fontFamily: 'monospace' }}>
                    {fileContent}
                  </Text>
                )}
              </ScrollView>
            )
          ) : (
            <View className="flex-1 items-center justify-center p-8">
              <Icon as={FileText} size={32} className="text-muted-foreground mb-2" />
              <Text className="text-xs text-muted-foreground">No content available</Text>
            </View>
          )}
        </View>
      </View>
    );
  }

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      onPress={handlePress}
      style={animatedStyle}
      className="flex-row items-center gap-2 px-4 py-2 rounded-3xl bg-card border border-border mb-2 active:bg-muted/50"
    >
      <View className="h-8 w-8 rounded-xl items-center justify-center border border-border mr-3 bg-background">
        <Icon
          as={FileText}
          size={compact ? 18 : 20}
          className="text-primary"
          strokeWidth={2}
        />
      </View>

      <View className="flex-1">
        <Text
          className="text-sm font-roobert-medium text-foreground"
          numberOfLines={1}
        >
          {file.name}
        </Text>
        {file.extension && (
          <Text className="text-xs text-muted-foreground font-roobert mt-0.5">
            {file.extension.toUpperCase()} Document
          </Text>
        )}
      </View>

      <View className="h-8 w-8 rounded-xl items-center justify-center bg-background ml-3">
        <Icon
          as={ExternalLink}
          size={16}
          className="text-muted-foreground"
          strokeWidth={2}
        />
      </View>
    </AnimatedPressable>
  );
}

/**
 * Generic File Attachment Component
 */
function GenericAttachment({
  file,
  compact,
  onPress,
}: {
  file: FileAttachment;
  compact: boolean;
  onPress?: (path: string) => void;
}) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    if (onPress) {
      onPress(file.path);
    }
  };

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      onPress={handlePress}
      style={animatedStyle}
      className="flex-row items-center gap-2 px-4 py-2 rounded-3xl bg-card border border-border mb-2 active:bg-muted/50"
    >
      <View className="h-8 w-8 rounded-xl items-center justify-center border border-border mr-3 bg-background">
        <Icon
          as={File}
          size={compact ? 18 : 20}
          className="text-muted-foreground"
          strokeWidth={2}
        />
      </View>

      <View className="flex-1">
        <Text
          className="text-sm font-roobert-medium text-foreground"
          numberOfLines={1}
        >
          {file.name}
        </Text>
        {file.extension && (
          <Text className="text-xs text-muted-foreground font-roobert mt-0.5">
            {file.extension.toUpperCase()} File
          </Text>
        )}
      </View>

      <View className="h-8 w-8 rounded-xl items-center justify-center bg-background ml-3">
        <Icon
          as={Download}
          size={16}
          className="text-muted-foreground"
          strokeWidth={2}
        />
      </View>
    </AnimatedPressable>
  );
}

/**
 * Presentation Attachment Component - Renders slide preview card
 * Similar to frontend's PresentationSlidePreview
 */
function PresentationAttachment({
  presentationName,
  slideNumber,
  filePath,
  sandboxUrl,
}: {
  presentationName: string;
  slideNumber: number;
  filePath: string;
  sandboxUrl: string;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [containerWidth, setContainerWidth] = useState(0);
  const [fullScreenVisible, setFullScreenVisible] = useState(false);

  const slidePreviewUrl = useMemo(() => {
    const url = constructHtmlPreviewUrl(sandboxUrl, filePath);
    return `${url}?t=${Date.now()}`;
  }, [sandboxUrl, filePath]);

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Open the presentation viewer instead of passing to parent's file handler
    setFullScreenVisible(true);
  };

  const handleFullScreenClose = useCallback(() => {
    setFullScreenVisible(false);
  }, []);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setContainerWidth(width);
  }, []);

  // Calculate the scale factor to fit 1920x1080 content into the container
  const scale = containerWidth / 1920;

  return (
    <View
      className="bg-card rounded-2xl overflow-hidden mb-3"
      style={{
        borderWidth: 1,
        borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
      }}
    >
      {/* Slide Preview - 16:9 */}
      <Pressable onPress={handlePress}>
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
                key={`slide-${slideNumber}-${filePath}`}
                source={{ uri: slidePreviewUrl }}
                scrollEnabled={false}
                showsVerticalScrollIndicator={false}
                showsHorizontalScrollIndicator={false}
                style={{ width: 1920, height: 1080, backgroundColor: 'white' }}
                originWhitelist={['*']}
                javaScriptEnabled={false}
                domStorageEnabled={false}
                onMessage={() => { }}
              />
            </View>
          )}
        </View>
      </Pressable>

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
            <Text className="text-xs font-mono font-medium text-foreground">
              #{slideNumber}
            </Text>
          </View>
          <Text
            className="text-sm flex-1 text-muted-foreground"
            numberOfLines={1}
          >
            {presentationName}
          </Text>
        </View>

        {/* Open button */}
        <Pressable
          onPress={handlePress}
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
      </View>

      {/* Full Screen Presentation Viewer */}
      <FullScreenPresentationViewer
        visible={fullScreenVisible}
        onClose={handleFullScreenClose}
        presentationName={presentationName}
        sandboxUrl={sandboxUrl}
        initialSlide={slideNumber}
      />
    </View>
  );
}

/**
 * HTML Preview Attachment Component - Renders HTML files with iframe preview
 * Similar to frontend's HtmlRenderer
 */
function HtmlPreviewAttachment({
  file,
  sandboxUrl,
  onPress,
}: {
  file: FileAttachment;
  sandboxUrl: string;
  onPress?: (path: string) => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const previewUrl = useMemo(() => {
    return constructHtmlPreviewUrl(sandboxUrl, file.path);
  }, [sandboxUrl, file.path]);

  const handlePress = () => {
    if (onPress) {
      onPress(file.path);
    }
  };

  return (
    <View
      className="mb-3 rounded-2xl overflow-hidden bg-card"
      style={{
        width: '100%',
        borderWidth: 1,
        borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
      }}
    >
      {/* Header */}
      <Pressable
        onPress={handlePress}
        className="px-4 py-3"
        style={{
          backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
          borderBottomWidth: 1,
          borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.08)' : 'rgba(18, 18, 21, 0.06)',
        }}
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <Icon as={FileText} size={16} className="text-muted-foreground" />
            <Text className="text-sm font-roobert-medium text-foreground" numberOfLines={1}>
              {file.name}
            </Text>
          </View>
          <Icon as={ExternalLink} size={14} className="text-muted-foreground" />
        </View>
      </Pressable>

      {/* HTML Preview */}
      <View style={{ height: 300, backgroundColor: 'white' }}>
        <WebView
          source={{ uri: previewUrl }}
          style={{ width: '100%', height: 300 }}
          scrollEnabled={true}
          originWhitelist={['*']}
          javaScriptEnabled={false}
          domStorageEnabled={false}
        />
      </View>
    </View>
  );
}

/**
 * Multi-file attachment renderer
 */
export function FileAttachmentsGrid({
  filePaths,
  sandboxId,
  sandboxUrl,
  compact = false,
  onFilePress,
  showPreviews = false,
}: {
  filePaths: string[];
  sandboxId?: string;
  /** Sandbox URL for direct file access (used for presentations and HTML previews) */
  sandboxUrl?: string;
  compact?: boolean;
  onFilePress?: (path: string) => void;
  showPreviews?: boolean;
}) {
  if (filePaths.length === 0) return null;

  return (
    <View className="my-2">
      {filePaths.map((path, index) => (
        <FileAttachmentRenderer
          key={`${path}-${index}`}
          filePath={path}
          sandboxId={sandboxId}
          sandboxUrl={sandboxUrl}
          compact={compact}
          showPreview={showPreviews}
          onPress={onFilePress}
        />
      ))}
    </View>
  );
}
