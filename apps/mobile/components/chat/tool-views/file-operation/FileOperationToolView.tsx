import React, { useState, useEffect, useMemo, useRef } from 'react';
import { View, ScrollView, Pressable, WebView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  Code,
  Eye,
  FileText,
  Presentation,
  Pencil,
  Loader2,
  Copy,
  Check,
} from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import {
  getOperationType,
  getOperationConfigs,
  getOperationTitle,
  processFilePath,
  getFileName,
  getFileExtension,
  isFileType,
  getLanguageFromFileName,
  hasLanguageHighlighting,
  splitContentIntoLines,
  generateEmptyLines,
} from './_utils';
import { MarkdownRenderer } from './MarkdownRenderer';
import { CsvRenderer } from './CsvRenderer';
import { XlsxRenderer } from './XlsxRenderer';
import { ToolViewCard, TabSwitcher, StatusBadge, LoadingState, CodeRenderer } from '../shared';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';
import { PresentationSlideCard } from '../presentation-tool/PresentationSlideCard';

// Helper functions for presentation slide detection
function isPresentationSlideFile(filepath: string): boolean {
  const presentationPattern = /presentations\/([^\/]+)\/slide_\d+\.html$/i;
  return presentationPattern.test(filepath);
}

function extractPresentationName(filepath: string): string | null {
  const match = filepath.match(/presentations\/([^\/]+)\//i);
  return match ? match[1] : null;
}

function extractSlideNumber(filepath: string): number | null {
  const match = filepath.match(/slide_(\d+)\.html$/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

function processUnicodeContent(text: string, preserveWhitespace = false): string {
  let processed = text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\r\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, preserveWhitespace ? '\t' : '  ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');

  return processed;
}

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

export function FileOperationToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
  streamingText,
}: ToolViewProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { openFileInComputer } = useKortixComputerStore();
  const [isCopyingContent, setIsCopyingContent] = useState(false);
  const [activeTab, setActiveTab] = useState<'code' | 'preview'>('preview');
  const sourceScrollRef = useRef<ScrollView>(null);
  const previewScrollRef = useRef<ScrollView>(null);
  const lastLineCountRef = useRef<number>(0);

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const args = toolCall.arguments || {};
  const output = toolResult?.output;

  const operation = getOperationType(name, args);
  const configs = getOperationConfigs();
  const config = configs[operation];
  const OperationIcon = config.icon;

  let filePath: string | null = null;
  let fileContent: string | null = null;

  // Extract file path from arguments (from metadata)
  filePath = args.file_path || args.target_file || args.path || null;

  // Also try to get file path from output first (more reliable for completed operations)
  if (output && typeof output === 'object' && output !== null) {
    if (!filePath && (output.file_path || output.path)) {
      filePath = output.file_path || output.path;
    }
  }

  // STREAMING: Extract content from live streaming JSON arguments
  if (isStreaming && streamingText) {
    try {
      // Try parsing as complete JSON first
      const parsed = JSON.parse(streamingText);

      // Extract based on operation type
      if (operation === 'create' || operation === 'rewrite') {
        if (parsed.file_contents) {
          fileContent = parsed.file_contents;
        }
      } else if (operation === 'edit') {
        if (parsed.code_edit) {
          fileContent = parsed.code_edit;
        }
      }

      // Extract file_path if not already set
      if (!filePath && parsed.file_path) {
        filePath = parsed.file_path;
      }
    } catch (e) {
      // JSON incomplete - extract partial content
      if (operation === 'create' || operation === 'rewrite') {
        // Find the start of file_contents value
        const startMatch = streamingText.match(/"file_contents"\s*:\s*"/);
        if (startMatch) {
          const startIndex = startMatch.index! + startMatch[0].length;
          // Extract everything after "file_contents": " until we hit the end or a closing quote
          let rawContent = streamingText.substring(startIndex);

          // Try to find the end quote (but it might not exist yet during streaming)
          const endQuoteMatch = rawContent.match(/(?<!\\)"/);
          if (endQuoteMatch) {
            rawContent = rawContent.substring(0, endQuoteMatch.index);
          }

          // Unescape JSON sequences like \n, \t, \\, \"
          try {
            fileContent = JSON.parse('"' + rawContent + '"');
          } catch {
            // If unescaping fails, replace common escapes manually
            fileContent = rawContent
              .replace(/\\n/g, '\n')
              .replace(/\\t/g, '\t')
              .replace(/\\r/g, '\r')
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, '\\');
          }
        }
      } else if (operation === 'edit') {
        const startMatch = streamingText.match(/"code_edit"\s*:\s*"/);
        if (startMatch) {
          const startIndex = startMatch.index! + startMatch[0].length;
          let rawContent = streamingText.substring(startIndex);

          const endQuoteMatch = rawContent.match(/(?<!\\)"/);
          if (endQuoteMatch) {
            rawContent = rawContent.substring(0, endQuoteMatch.index);
          }

          try {
            fileContent = JSON.parse('"' + rawContent + '"');
          } catch {
            fileContent = rawContent
              .replace(/\\n/g, '\n')
              .replace(/\\t/g, '\t')
              .replace(/\\r/g, '\r')
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, '\\');
          }
        }
      }

      // Extract file_path from partial JSON
      if (!filePath) {
        const pathMatch = streamingText.match(/"file_path"\s*:\s*"([^"]+)"/);
        if (pathMatch) {
          filePath = pathMatch[1];
        }
      }
    }
  }

  // Fallback: Extract content from args (for completed operations)
  if (!fileContent) {
    fileContent = args.file_contents || args.code_edit || args.updated_content || args.content || null;
  }

  // Override with output if available
  if (output) {
    if (typeof output === 'object' && output !== null) {
      fileContent = output.file_content || output.content || output.updated_content || output.file_contents || fileContent;
      if (!filePath && output.file_path) {
        filePath = output.file_path;
      }
    } else if (typeof output === 'string' && operation !== 'delete' && operation !== 'create') {
      fileContent = output;
    }
  }

  // Debug logging for content extraction
  if (operation === 'create' || operation === 'edit' || operation === 'rewrite') {
    console.log('[FileOperationToolView] Content extraction:', {
      operation,
      hasFileContent: !!fileContent,
      fileContentLength: fileContent?.length || 0,
      filePath,
      hasStreamingText: !!streamingText,
      isStreaming,
      argsKeys: Object.keys(args),
      outputType: typeof output,
    });
  }

  const toolTitle = getOperationTitle(operation);
  const processedFilePath = processFilePath(filePath);
  const fileName = getFileName(processedFilePath);
  const fileExtension = getFileExtension(fileName);

  const isHtml = isFileType.html(fileExtension);
  const isMarkdown = fileExtension === 'md' || fileExtension === 'markdown';
  const isCsv = fileExtension === 'csv' || fileExtension === 'tsv';
  const isXlsx = fileExtension === 'xlsx' || fileExtension === 'xls';

  // Check if this is a presentation slide file
  const isPresentationSlide = processedFilePath ? isPresentationSlideFile(processedFilePath) : false;
  const presentationName = isPresentationSlide && processedFilePath ? extractPresentationName(processedFilePath) : null;
  const slideNumber = isPresentationSlide && processedFilePath ? extractSlideNumber(processedFilePath) : null;

  const language = getLanguageFromFileName(fileName);
  const hasHighlighting = hasLanguageHighlighting(language);
  const contentLines = useMemo(() => splitContentIntoLines(fileContent), [fileContent]);

  const htmlPreviewUrl =
    isHtml && project?.sandbox?.sandbox_url && processedFilePath
      ? constructHtmlPreviewUrl(project.sandbox.sandbox_url, processedFilePath)
      : undefined;

  const FileIcon = config.icon;

  // Auto-scroll for source code view during streaming
  useEffect(() => {
    if (!isStreaming || !fileContent || !sourceScrollRef.current) return;

    const currentLineCount = contentLines.length;
    if (currentLineCount <= lastLineCountRef.current) return;
    lastLineCountRef.current = currentLineCount;

    // Scroll to bottom
    setTimeout(() => {
      sourceScrollRef.current?.scrollToEnd({ animated: false });
    }, 100);
  }, [isStreaming, contentLines.length, fileContent]);

  useEffect(() => {
    if (!isStreaming) {
      lastLineCountRef.current = 0;
    }
  }, [isStreaming]);

  // Auto-scroll for preview tab during streaming
  useEffect(() => {
    if (!isStreaming || !fileContent || !previewScrollRef.current) return;
    setTimeout(() => {
      previewScrollRef.current?.scrollToEnd({ animated: false });
    }, 100);
  }, [isStreaming, fileContent]);

  const handleCopyContent = async () => {
    if (!fileContent) return;

    setIsCopyingContent(true);
    try {
      await Clipboard.setStringAsync(fileContent);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
    setTimeout(() => setIsCopyingContent(false), 500);
  };

  const renderFilePreview = () => {
    // Handle presentation slide files specially
    if (isPresentationSlide && presentationName) {
      if (isStreaming) {
        return (
          <View className="flex-1 items-center justify-center p-8">
            <View className="bg-primary/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
              <Icon as={Presentation} size={40} className="text-primary" strokeWidth={2} />
            </View>
            <Text className="text-lg font-roobert-semibold mb-2 text-foreground">
              Updating Presentation
            </Text>
            <Text className="text-sm text-muted-foreground text-center mb-4">
              {presentationName}{slideNumber ? ` - Slide ${slideNumber}` : ''}
            </Text>
            <View className="flex-row items-center gap-2">
              <Icon as={Loader2} size={16} className="text-primary" />
              <Text className="text-sm text-primary">Writing slide content...</Text>
            </View>
          </View>
        );
      }

      if (project?.sandbox?.sandbox_url) {
        return (
          <View className="flex-1 p-4">
            <PresentationSlideCard
              slide={{
                number: slideNumber || 1,
                title: `Slide ${slideNumber || 1}`,
                filename: `slide_${String(slideNumber || 1).padStart(2, '0')}.html`,
                file_path: processedFilePath || '',
                preview_url: '',
                created_at: '',
              }}
              sandboxUrl={project.sandbox.sandbox_url}
              onFullScreenClick={(slideNum) => {
                // Open in fullscreen presentation viewer
                // This would need to integrate with presentation viewer store
              }}
            />
          </View>
        );
      }

      return (
        <View className="flex-1 items-center justify-center p-8">
          <View className="bg-primary/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
            <Icon as={Presentation} size={40} className="text-primary" strokeWidth={2} />
          </View>
          <Text className="text-lg font-roobert-semibold mb-2 text-foreground">
            Presentation Updated
          </Text>
          <Text className="text-sm text-muted-foreground text-center">
            {presentationName}{slideNumber ? ` - Slide ${slideNumber}` : ''}
          </Text>
          <Text className="text-xs text-muted-foreground mt-2">
            Waiting for sandbox to be ready...
          </Text>
        </View>
      );
    }

    if (!fileContent) {
      return (
        <View className="flex-1 items-center justify-center p-12">
          <Icon as={FileIcon} size={48} className="text-muted-foreground mb-4" />
          <Text className="text-sm text-muted-foreground">No content to preview</Text>
        </View>
      );
    }

    // For HTML files with preview URL, use WebView
    if (isHtml && htmlPreviewUrl) {
      return (
        <View className="flex-1">
          <WebView
            source={{ uri: htmlPreviewUrl }}
            style={{ flex: 1 }}
            javaScriptEnabled={true}
            domStorageEnabled={true}
          />
        </View>
      );
    }

    // For markdown files
    if (isMarkdown) {
      return (
        <ScrollView ref={previewScrollRef} className="flex-1" showsVerticalScrollIndicator={false}>
          <View className="p-4">
            <MarkdownRenderer content={processUnicodeContent(fileContent)} />
          </View>
        </ScrollView>
      );
    }

    // For CSV files
    if (isCsv) {
      return (
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          <View className="p-4">
            <CsvRenderer content={processUnicodeContent(fileContent)} />
          </View>
        </ScrollView>
      );
    }

    // For XLSX files
    if (isXlsx) {
      return (
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          <View className="p-4">
            <XlsxRenderer
              content={fileContent}
              filePath={processedFilePath}
              fileName={fileName}
            />
          </View>
        </ScrollView>
      );
    }

    // For all other files, use CodeRenderer
    return (
      <ScrollView ref={previewScrollRef} className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="p-4">
          <CodeRenderer
            code={processUnicodeContent(fileContent)}
            language={language}
            showLineNumbers={false}
          />
        </View>
      </ScrollView>
    );
  };

  const renderSourceCode = () => {
    if (!fileContent) {
      return (
        <View className="flex-1 items-center justify-center p-12">
          <Icon as={FileIcon} size={48} className="text-muted-foreground mb-4" />
          <Text className="text-sm text-muted-foreground">No source code to display</Text>
        </View>
      );
    }

    const emptyLines = generateEmptyLines(50);
    const allLines = [...contentLines, ...emptyLines];

    return (
      <ScrollView
        ref={sourceScrollRef}
        className="flex-1"
        showsVerticalScrollIndicator={false}
      >
        <View className="p-4">
          {allLines.map((line, idx) => (
            <View key={idx} className="flex-row">
              <View className="w-12 items-end pr-4">
                <Text className="text-xs text-muted-foreground font-roobert-mono">
                  {idx + 1}
                </Text>
              </View>
              <View className="flex-1">
                <Text className="text-sm font-roobert-mono text-foreground/80 leading-5" selectable>
                  {line ? processUnicodeContent(line, true) : ' '}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    );
  };

  const HeaderIcon = isPresentationSlide ? Presentation : OperationIcon;
  const headerIconColor = isPresentationSlide ? 'text-primary' : config.color;
  const headerBgColor = isPresentationSlide ? 'bg-primary/10 border-primary/20' : config.bgColor;
  const displayTitle = isPresentationSlide && presentationName
    ? `${toolTitle} - ${presentationName}${slideNumber ? ` (Slide ${slideNumber})` : ''}`
    : toolTitle;

  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  // Show loading state during streaming with no content
  if (isStreaming && !fileContent && !filePath) {
    return (
      <ToolViewCard
        header={{
          icon: HeaderIcon,
          iconColor: headerIconColor,
          iconBgColor: headerBgColor,
          subtitle: 'FILE OPERATION',
          title: displayTitle,
          isSuccess: actualIsSuccess,
          isStreaming: true,
          rightContent: (
            <StatusBadge variant="streaming" label="Processing" />
          ),
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={HeaderIcon}
            iconColor={headerIconColor}
            bgColor={headerBgColor}
            title={config.progressMessage}
            filePath={processedFilePath || 'Processing file...'}
            showProgress={true}
          />
        </View>
      </ToolViewCard>
    );
  }

  // Show delete operation
  if (operation === 'delete') {
    return (
      <ToolViewCard
        header={{
          icon: OperationIcon,
          iconColor: config.color,
          iconBgColor: config.bgColor,
          subtitle: 'FILE OPERATION',
          title: displayTitle,
          isSuccess: actualIsSuccess,
          isStreaming: isStreaming,
          rightContent: !isStreaming && (
            <StatusBadge
              variant={actualIsSuccess ? 'success' : 'error'}
              label={actualIsSuccess ? 'Deleted' : 'Failed'}
            />
          ),
        }}
      >
        <View className="flex-1 w-full items-center justify-center py-12 px-6">
          <View className={`${config.bgColor} rounded-2xl items-center justify-center mb-6`} style={{ width: 80, height: 80 }}>
            <Icon as={OperationIcon} size={40} className={config.color} strokeWidth={2} />
          </View>
          <Text className="text-xl font-roobert-semibold mb-6 text-foreground">
            File Deleted
          </Text>
          {processedFilePath && (
            <View className="bg-muted border border-border rounded-xl p-4 w-full max-w-md mb-4">
              <Text className="text-sm font-roobert-mono text-foreground/80 text-center" numberOfLines={3}>
                {processedFilePath}
              </Text>
            </View>
          )}
          <Text className="text-sm text-muted-foreground text-center">
            This file has been permanently removed
          </Text>
        </View>
      </ToolViewCard>
    );
  }

  const hasPreview = isMarkdown || isHtml || isCsv || isXlsx || isPresentationSlide;

  return (
    <ToolViewCard
      header={{
        icon: HeaderIcon,
        iconColor: headerIconColor,
        iconBgColor: headerBgColor,
        subtitle: 'FILE OPERATION',
        title: displayTitle,
        isSuccess: actualIsSuccess,
        isStreaming: isStreaming,
        rightContent: (
          <View className="flex-row items-center gap-2">
            {hasPreview && (
              <TabSwitcher
                tabs={[
                  { id: 'code', label: 'Source', icon: Code },
                  { id: 'preview', label: 'Preview', icon: Eye },
                ]}
                activeTab={activeTab}
                onTabChange={(tabId) => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setActiveTab(tabId as 'code' | 'preview');
                }}
              />
            )}
            {fileContent && !isStreaming && !isPresentationSlide && (
              <Pressable
                onPress={handleCopyContent}
                disabled={isCopyingContent}
                className="h-8 w-8 items-center justify-center rounded-lg active:opacity-70"
                style={{
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
                }}
              >
                <Icon
                  as={isCopyingContent ? Check : Copy}
                  size={16}
                  className={isCopyingContent ? 'text-primary' : 'text-foreground'}
                />
              </Pressable>
            )}
            {processedFilePath && !isStreaming && !isPresentationSlide && operation !== 'delete' && (
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  openFileInComputer(processedFilePath);
                }}
                className="flex-row items-center gap-1.5 px-2 py-1.5 rounded-lg active:opacity-70"
                style={{
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
                  borderWidth: 1,
                  borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                }}
              >
                <Icon as={Pencil} size={14} className="text-foreground" />
                <Text className="text-xs font-roobert-medium text-foreground">Edit</Text>
              </Pressable>
            )}
            {!isStreaming && (
              <StatusBadge
                variant={actualIsSuccess ? 'success' : 'error'}
                label={actualIsSuccess ? 'Success' : 'Failed'}
              />
            )}
            {isStreaming && <StatusBadge variant="streaming" label="Processing" />}
          </View>
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          <View className="flex-row items-center gap-2">
            {processedFilePath && (
              <View
                className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full border"
                style={{
                  borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                }}
              >
                <Icon as={FileText} size={12} className="text-foreground" />
                <Text className="text-xs font-roobert-medium text-foreground" numberOfLines={1}>
                  {fileName || 'File'}
                </Text>
              </View>
            )}
            <View
              className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full border"
              style={{
                borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
              }}
            >
              <Icon as={FileIcon} size={12} className="text-foreground" />
              <Text className="text-xs font-roobert-medium text-foreground">
                {hasHighlighting ? language.toUpperCase() : fileExtension.toUpperCase() || 'TEXT'}
              </Text>
            </View>
          </View>
          {toolTimestamp && !isStreaming && (
            <Text className="text-xs text-muted-foreground">
              {formatTimestamp(toolTimestamp)}
            </Text>
          )}
        </View>
      }
    >
      <View className="flex-1 w-full">
        {activeTab === 'code' ? renderSourceCode() : renderFilePreview()}
      </View>
    </ToolViewCard>
  );
}
