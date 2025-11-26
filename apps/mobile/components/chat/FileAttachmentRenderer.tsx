/**
 * File Attachment Renderer - Modular component for rendering uploaded files
 * 
 * Supports:
 * - Images (jpg, jpeg, png, gif, webp, svg)
 * - Documents (pdf, doc, docx, etc.)
 * - Other file types
 * 
 * Can be used in:
 * - Chat messages
 * - Tool outputs
 * - Any context where files need to be displayed
 */

import React, { useState, useMemo, useEffect } from 'react';
import { View, Image, Pressable, ActivityIndicator, Linking, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { FileText, File, Download, ExternalLink, Image as ImageIcon } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import Markdown from 'react-native-markdown-display';
import { markdownStyles, markdownStylesDark } from '@/lib/utils/markdown-styles';
import { WebView } from 'react-native-webview';
import { getAuthToken } from '@/api/config';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

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
 * Parse file path and determine type
 */
function parseFilePath(path: string): FileAttachment {
  const name = path.split('/').pop() || 'file';
  const extension = name.split('.').pop()?.toLowerCase();
  
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'];
  const documentExtensions = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'];
  
  let type: 'image' | 'document' | 'other' = 'other';
  
  if (extension && imageExtensions.includes(extension)) {
    type = 'image';
  } else if (extension && documentExtensions.includes(extension)) {
    type = 'document';
  }
  
  return { path, type, name, extension };
}

/**
 * Main File Attachment Renderer Component
 */
export function FileAttachmentRenderer({
  filePath,
  sandboxId,
  compact = false,
  showName = true,
  showPreview = false,
  onPress,
}: FileAttachmentRendererProps) {
  const file = useMemo(() => parseFilePath(filePath), [filePath]);
  
  switch (file.type) {
    case 'image':
      return (
        <ImageAttachment 
          file={file} 
          sandboxId={sandboxId}
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
          sandboxId={sandboxId}
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
  sandboxId,
  compact,
  showName,
  showPreview,
  onPress,
}: {
  file: FileAttachment;
  sandboxId?: string;
  compact: boolean;
  showName: boolean;
  showPreview: boolean;
  onPress?: (path: string) => void;
}) {
  const { colorScheme } = useColorScheme();
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const scale = useSharedValue(1);
  
  // For sandbox files, we need to use blob URLs with authentication
  // The useSandboxImageBlob hook handles this properly
  const [blobUrl, setBlobUrl] = useState<string | undefined>();

  useEffect(() => {
    if (sandboxId && file.path) {
      let filePath = file.path;
      if (!filePath.startsWith('/')) {
        filePath = '/workspace/' + filePath;
      }
      
      const fetchImage = async () => {
        try {
          const token = await getAuthToken();
          const response = await fetch(
            `${process.env.EXPO_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(filePath)}`,
            {
              headers: {
                'Authorization': `Bearer ${token}`,
              },
            }
          );
          
          if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status}`);
          }
          
          const blob = await response.blob();
          
          import('@/lib/files/hooks').then(({ blobToDataURL }) => {
            blobToDataURL(blob).then(setBlobUrl).catch(console.error);
          });
        } catch (error) {
          console.error('[ImageAttachment] Failed to fetch:', error);
        }
      };
      
      fetchImage();
    } else {
      setBlobUrl(file.path);
    }
  }, [sandboxId, file.path]);

  const imageUrl = blobUrl || file.path;

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
        className="rounded-2xl overflow-hidden border border-border bg-card"
      >
        <View style={{ width: showPreview ? '100%' : containerWidth, height: containerHeight }}>
          {!hasError ? (
            <>
              <Image
                source={{ uri: imageUrl }}
                style={{ width: '100%', height: '100%' }}
                resizeMode="cover"
                onLoadStart={() => setIsLoading(true)}
                onLoadEnd={() => setIsLoading(false)}
                onError={() => {
                  setIsLoading(false);
                  setHasError(true);
                }}
              />
              
              {isLoading && (
                <View className="absolute inset-0 bg-muted/50 items-center justify-center">
                  <ActivityIndicator 
                    size="small" 
                    color={colorScheme === 'dark' ? '#ffffff' : '#000000'} 
                  />
                </View>
              )}
            </>
          ) : (
            <View className="flex-1 items-center justify-center bg-muted/30">
              <Icon 
                as={ImageIcon} 
                size={32} 
                className="text-muted-foreground mb-2"
                strokeWidth={1.5}
              />
              <Text className="text-xs text-muted-foreground">
                Failed to load
              </Text>
            </View>
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
  sandboxId,
  onPress,
}: {
  file: FileAttachment;
  compact: boolean;
  showPreview: boolean;
  sandboxId?: string;
  onPress?: (path: string) => void;
}) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);
  const [fileContent, setFileContent] = useState<string | null>(null);
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
  
  const isPreviewable = useMemo(() => {
    if (!showPreview || !file.extension) return false;
    const ext = file.extension.toLowerCase();
    const result = ['md', 'markdown', 'html', 'htm', 'txt', 'json', 'csv'].includes(ext);
    return result;
  }, [showPreview, file.extension, file.path]);

  useEffect(() => {
    if (isPreviewable && sandboxId) {
      setIsLoading(true);
      setHasError(false);
      
      const fetchFileContent = async () => {
        try {
          const token = await getAuthToken();
          const apiUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
          
          let filePath = file.path;
          if (!filePath.startsWith('/')) {
            filePath = '/workspace/' + filePath;
          }
          
          const url = `${apiUrl}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(filePath)}`;
          const response = await fetch(url, {
            headers: {
              'Authorization': `Bearer ${token}`,
            },
          });
          
          if (!response.ok) {
            throw new Error(`Failed to fetch file: ${response.status}`);
          }
          
          const text = await response.text();
          console.log('[DocumentAttachment] Fetched content length:', text.length);
          setFileContent(text);
        } catch (error) {
          console.error('[DocumentAttachment] Failed to fetch file content:', error);
          setHasError(true);
        } finally {
          setIsLoading(false);
        }
      };
      
      fetchFileContent();
    }
  }, [isPreviewable, sandboxId, file.path]);
  
  if (showPreview && isPreviewable) {
    const ext = file.extension?.toLowerCase();
    const isMarkdown = ext === 'md' || ext === 'markdown';
    const isHtml = ext === 'html' || ext === 'htm';
    
    console.log('[DocumentAttachment] Render state:', {
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
              <Pressable onPress={handlePress} className="mt-3 px-4 py-2 bg-primary/10 rounded-2xl">
                <Text className="text-xs text-primary font-medium">Open file</Text>
              </Pressable>
            </View>
          ) : fileContent ? (
            isHtml ? (
              <WebView
                source={{ html: fileContent }}
                style={{ width: '100%', height: 400 }}
                scrollEnabled={true}
                originWhitelist={['*']}
              />
            ) : (
              <ScrollView className="p-4" style={{ height: 400 }} showsVerticalScrollIndicator={true}>
                {isMarkdown ? (
                  <Markdown style={colorScheme === 'dark' ? markdownStylesDark : markdownStyles}>
                    {fileContent}
                  </Markdown>
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
      className="flex-row items-center bg-muted/30 rounded-2xl px-3 py-3 border border-border/30 mb-2 active:bg-muted/50"
    >
      <View className="bg-primary/10 rounded-2xl p-2 mr-3">
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
      
      <Icon 
        as={ExternalLink} 
        size={16} 
        className="text-muted-foreground ml-2"
        strokeWidth={2}
      />
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
      className="flex-row items-center bg-muted/30 rounded-2xl px-3 py-3 border border-border/30 mb-2 active:bg-muted/50"
    >
      <View className="bg-muted rounded-2xl p-2 mr-3">
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
      
      <Icon 
        as={Download} 
        size={16} 
        className="text-muted-foreground ml-2"
        strokeWidth={2}
      />
    </AnimatedPressable>
  );
}

/**
 * Parse message content and extract file references
 * Matches: [Uploaded File: /workspace/uploads/filename.ext]
 */
export function extractFileReferences(content: string): string[] {
  const filePattern = /\[Uploaded File: ([^\]]+)\]/g;
  const matches = content.matchAll(filePattern);
  const files: string[] = [];
  
  for (const match of matches) {
    files.push(match[1]);
  }
  
  return files;
}

/**
 * Remove file references from content to get clean text
 */
export function removeFileReferences(content: string): string {
  return content.replace(/\[Uploaded File: [^\]]+\]/g, '').trim();
}

/**
 * Multi-file attachment renderer
 */
export function FileAttachmentsGrid({
  filePaths,
  sandboxId,
  compact = false,
  onFilePress,
  showPreviews = false,
}: {
  filePaths: string[];
  sandboxId?: string;
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
          compact={compact}
          showPreview={showPreviews}
          onPress={onFilePress}
        />
      ))}
    </View>
  );
}

