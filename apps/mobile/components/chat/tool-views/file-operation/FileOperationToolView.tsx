import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { View, ScrollView, Pressable, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { WebView } from 'react-native-webview';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui/kortix-loader';
import {
  Code,
  Eye,
  FileText,
  Presentation,
  Pencil,
  Copy,
  Check,
  FileDiff,
  Plus,
  Minus,
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
  generateLineDiff,
  calculateDiffStats,
  type LineDiff,
} from './_utils';
import { MarkdownRenderer } from './MarkdownRenderer';
import { JsonRenderer } from './JsonRenderer';
import { CsvRenderer } from './CsvRenderer';
import { XlsxRenderer } from './XlsxRenderer';
import { ToolViewCard, TabSwitcher, StatusBadge, LoadingState, CodeRenderer, FileDownloadButton } from '../shared';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { PresentationSlideCard } from '../presentation-tool/PresentationSlideCard';
import { log } from '@/lib/logger';

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
  const { openFileInComputer } = useKortixComputerStore();
  const [isCopyingContent, setIsCopyingContent] = useState(false);
  const [activeTab, setActiveTab] = useState<'code' | 'preview' | 'changes'>('preview');
  const sourceScrollRef = useRef<ScrollView>(null);
  const previewScrollRef = useRef<ScrollView>(null);
  const lastLineCountRef = useRef<number>(0);
  const tabInitializedRef = useRef<boolean>(false);
  const [isSourceScrolledUp, setIsSourceScrolledUp] = useState(false);
  const [isPreviewScrolledUp, setIsPreviewScrolledUp] = useState(false);

  // Track if user has scrolled away from bottom (for source tab)
  const handleSourceScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    // Consider "at bottom" if within 50px of the bottom
    setIsSourceScrolledUp(distanceFromBottom > 50);
  }, []);

  // Track if user has scrolled away from bottom (for preview tab)
  const handlePreviewScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    // Consider "at bottom" if within 50px of the bottom
    setIsPreviewScrolledUp(distanceFromBottom > 50);
  }, []);

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const rawArgs = toolCall.arguments || {};
  const args: Record<string, any> = typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {};
  const output = toolResult?.output;

  const operation = getOperationType(name);
  const isStrReplace = operation === 'str-replace';
  const configs = getOperationConfigs();
  const config = configs[operation];
  const OperationIcon = config.icon;

  let filePath: string | null = null;
  let fileContent: string | null = null;
  let oldStr: string | null = null;
  let newStr: string | null = null;

  // Extract file path from arguments
  filePath = args.file_path || args.target_file || args.path || null;

  // Extract str-replace specific arguments
  if (isStrReplace) {
    oldStr = args.old_str || args.old_string || null;
    newStr = args.new_str || args.new_string || null;
  }

  // Also try to get file path from output first
  if (output && typeof output === 'object' && output !== null) {
    if (!filePath && (output.file_path || output.path)) {
      filePath = output.file_path || output.path;
    }
  }

  // STREAMING: Extract content from live streaming JSON arguments
  if (isStreaming && streamingText) {
    try {
      const parsed = JSON.parse(streamingText);

      if (operation === 'create' || operation === 'rewrite') {
        if (parsed.file_contents) {
          fileContent = parsed.file_contents;
        }
      } else if (operation === 'edit') {
        if (parsed.code_edit) {
          fileContent = parsed.code_edit;
        }
      } else if (isStrReplace) {
        if (parsed.old_str || parsed.old_string) {
          oldStr = parsed.old_str || parsed.old_string;
        }
        if (parsed.new_str || parsed.new_string) {
          newStr = parsed.new_str || parsed.new_string;
        }
      }

      if (!filePath && parsed.file_path) {
        filePath = parsed.file_path;
      }
    } catch (e) {
      // JSON incomplete - extract partial content
      if (operation === 'create' || operation === 'rewrite') {
        const startMatch = streamingText.match(/"file_contents"\s*:\s*"/);
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
      } else if (isStrReplace) {
        const oldStrMatch = streamingText.match(/"(?:old_str|old_string)"\s*:\s*"/);
        if (oldStrMatch) {
          const startIndex = oldStrMatch.index! + oldStrMatch[0].length;
          let rawContent = streamingText.substring(startIndex);
          const endQuoteMatch = rawContent.match(/(?<!\\)"/);
          if (endQuoteMatch) {
            rawContent = rawContent.substring(0, endQuoteMatch.index);
          }
          try {
            oldStr = JSON.parse('"' + rawContent + '"');
          } catch {
            oldStr = rawContent.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          }
        }
        const newStrMatch = streamingText.match(/"(?:new_str|new_string)"\s*:\s*"/);
        if (newStrMatch) {
          const startIndex = newStrMatch.index! + newStrMatch[0].length;
          let rawContent = streamingText.substring(startIndex);
          const endQuoteMatch = rawContent.match(/(?<!\\)"/);
          if (endQuoteMatch) {
            rawContent = rawContent.substring(0, endQuoteMatch.index);
          }
          try {
            newStr = JSON.parse('"' + rawContent + '"');
          } catch {
            newStr = rawContent.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          }
        }
      }

      if (!filePath) {
        const pathMatch = streamingText.match(/"file_path"\s*:\s*"([^"]+)"/);
        if (pathMatch) {
          filePath = pathMatch[1];
        }
      }
    }
  }

  // Fallback: Extract content from args
  if (!fileContent) {
    fileContent = args.file_contents || args.code_edit || args.updated_content || args.content || null;
  }

  // Override with output if available
  if (output) {
    if (typeof output === 'object' && output !== null) {
      // For str-replace, extract oldStr and newStr first
      if (isStrReplace) {
        oldStr = oldStr || output.old_str || output.old_string || null;
        newStr = newStr || output.new_str || output.new_string || null;
        // For str-replace, use newStr as fileContent for Source/Preview tabs
        if (newStr) {
          fileContent = newStr;
        } else {
          fileContent = output.file_content || output.content || output.updated_content || output.file_contents || fileContent;
        }
      } else {
        fileContent = output.file_content || output.content || output.updated_content || output.file_contents || fileContent;
      }
      if (!filePath && output.file_path) {
        filePath = output.file_path;
      }
    } else if (typeof output === 'string' && operation !== 'delete' && operation !== 'create') {
      fileContent = output;
    }
  }

  // Final fallback: For str-replace operations, use newStr as fileContent if we don't have fileContent yet
  if (isStrReplace && !fileContent && newStr) {
    fileContent = newStr;
  }

  // Debug: Log content extraction
  if (operation === 'create' || operation === 'edit' || operation === 'rewrite' || isStrReplace) {
    log.log('[FileOperationToolView] Content extraction:', {
      operation,
      isStrReplace,
      hasFileContent: !!fileContent,
      fileContentLength: fileContent?.length || 0,
      hasOldStr: !!oldStr,
      hasNewStr: !!newStr,
      filePath,
      hasStreamingText: !!streamingText,
      isStreaming,
    });
  }

  // Generate diff data for str-replace
  const lineDiff = useMemo(() => {
    if (oldStr && newStr) {
      return generateLineDiff(oldStr, newStr);
    }
    return [];
  }, [oldStr, newStr]);

  const diffStats = useMemo(() => {
    return calculateDiffStats(lineDiff);
  }, [lineDiff]);

  const toolTitle = getOperationTitle(operation);
  const processedFilePath = processFilePath(filePath);
  const fileName = getFileName(processedFilePath);
  const fileExtension = getFileExtension(fileName);

  const isHtml = isFileType.html(fileExtension);
  const isMarkdown = fileExtension === 'md' || fileExtension === 'markdown';
  const isJson = fileExtension === 'json';
  const isCsv = fileExtension === 'csv' || fileExtension === 'tsv';
  const isXlsx = fileExtension === 'xlsx' || fileExtension === 'xls';

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

  // Auto-scroll during streaming - only if user hasn't scrolled up
  useEffect(() => {
    if (!isStreaming || !fileContent || !sourceScrollRef.current || isSourceScrolledUp) return;
    const currentLineCount = contentLines.length;
    if (currentLineCount <= lastLineCountRef.current) return;
    lastLineCountRef.current = currentLineCount;
    setTimeout(() => {
      sourceScrollRef.current?.scrollToEnd({ animated: false });
    }, 100);
  }, [isStreaming, contentLines.length, fileContent, isSourceScrolledUp]);

  useEffect(() => {
    if (!isStreaming) {
      lastLineCountRef.current = 0;
      // Reset scroll state when streaming ends
      setIsSourceScrolledUp(false);
      setIsPreviewScrolledUp(false);
    }
  }, [isStreaming]);

  useEffect(() => {
    if (!isStreaming || !fileContent || !previewScrollRef.current || isPreviewScrolledUp) return;
    setTimeout(() => {
      previewScrollRef.current?.scrollToEnd({ animated: false });
    }, 100);
  }, [isStreaming, fileContent, isPreviewScrolledUp]);

  const handleCopyContent = async () => {
    if (!fileContent) return;
    setIsCopyingContent(true);
    try {
      await Clipboard.setStringAsync(fileContent);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      log.error('Failed to copy text: ', err);
    }
    setTimeout(() => setIsCopyingContent(false), 500);
  };


  const renderDiffView = () => {
    if (!oldStr || !newStr) {
      return (
        <View className="flex-1 items-center justify-center p-8">
          <View className="bg-card rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
            <Icon as={Check} size={32} className="text-primary" />
          </View>
          <Text className="text-sm font-roobert-medium text-primary">Replacement Complete</Text>
          <Text className="text-xs text-primary opacity-50 mt-1">{processedFilePath}</Text>
        </View>
      );
    }

    return (
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={true}
        nestedScrollEnabled={true}
      >
        <View className="p-2">
          {lineDiff.map((line, idx) => {
            if (line.type === 'unchanged') return null;

            return (
              <View
                key={idx}
                className={`flex-row items-start mb-1 rounded-lg overflow-hidden bg-card border-l-2 ${line.type === 'added' ? 'border-l-primary' : 'border-l-primary opacity-50'}`}
              >
                <View className="w-8 items-center justify-center py-2">
                  <Icon
                    as={line.type === 'added' ? Plus : Minus}
                    size={12}
                    className="text-primary"
                  />
                </View>
                <View className="w-10 items-end justify-center pr-2 py-2">
                  <Text className="text-[10px] font-roobert-mono text-primary opacity-50">
                    {line.lineNumber}
                  </Text>
                </View>
                <View className="flex-1 py-2 pr-3">
                  <Text
                    className="text-xs font-roobert-mono text-primary"
                    selectable
                  >
                    {line.type === 'added' ? line.newLine : line.oldLine}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
    );
  };

  const renderFilePreview = () => {
    if (isPresentationSlide && presentationName) {
      if (isStreaming) {
        return (
          <View className="flex-1 items-center justify-center p-8">
            <View className="bg-card rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
              <Icon as={Presentation} size={40} className="text-primary" strokeWidth={2} />
            </View>
            <Text className="text-lg font-roobert-semibold mb-2 text-primary">
              Updating Presentation
            </Text>
            <Text className="text-sm text-primary opacity-50 text-center mb-4">
              {presentationName}{slideNumber ? ` - Slide ${slideNumber}` : ''}
            </Text>
            <View className="flex-row items-center gap-2">
              <KortixLoader size="small" customSize={16} />
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
              onFullScreenClick={() => { }}
            />
          </View>
        );
      }

      return (
        <View className="flex-1 items-center justify-center p-8">
          <View className="bg-card rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
            <Icon as={Presentation} size={40} className="text-primary" strokeWidth={2} />
          </View>
          <Text className="text-lg font-roobert-semibold mb-2 text-primary">
            Presentation Updated
          </Text>
          <Text className="text-sm text-primary opacity-50 text-center">
            {presentationName}{slideNumber ? ` - Slide ${slideNumber}` : ''}
          </Text>
        </View>
      );
    }

    if (!fileContent) {
      return (
        <View className="flex-1 items-center justify-center p-12">
          <Icon as={FileIcon} size={48} className="text-primary opacity-50 mb-4" />
          <Text className="text-sm text-primary opacity-50">No content to preview</Text>
        </View>
      );
    }

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

    if (isMarkdown) {
      return (
        <ScrollView
          ref={previewScrollRef}
          className="flex-1"
          showsVerticalScrollIndicator={true}
          nestedScrollEnabled={true}
          onScroll={handlePreviewScroll}
          scrollEventThrottle={16}
        >
          <MarkdownRenderer content={fileContent} />
        </ScrollView>
      );
    }

    if (isJson) {
      return (
        <ScrollView
          ref={previewScrollRef}
          className="flex-1"
          showsVerticalScrollIndicator={true}
          nestedScrollEnabled={true}
          onScroll={handlePreviewScroll}
          scrollEventThrottle={16}
        >
          <JsonRenderer content={fileContent} />
        </ScrollView>
      );
    }

    if (isCsv) {
      return (
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={true}
          nestedScrollEnabled={true}
          onScroll={handlePreviewScroll}
          scrollEventThrottle={16}
        >
          <View className="p-4">
            <CsvRenderer content={fileContent} />
          </View>
        </ScrollView>
      );
    }

    if (isXlsx) {
      return (
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={true}
          nestedScrollEnabled={true}
          onScroll={handlePreviewScroll}
          scrollEventThrottle={16}
        >
          <View className="p-4">
            <XlsxRenderer content={fileContent} fileName={fileName} />
          </View>
        </ScrollView>
      );
    }

    // Default: Code preview
    return (
      <ScrollView
        ref={previewScrollRef}
        className="flex-1"
        showsVerticalScrollIndicator={true}
        nestedScrollEnabled={true}
        onScroll={handlePreviewScroll}
        scrollEventThrottle={16}
      >
        <View className="p-2">
          <CodeRenderer
            code={fileContent}
            language={language}
            showLineNumbers={true}
          />
        </View>
      </ScrollView>
    );
  };

  const renderSourceCode = () => {
    if (!fileContent) {
      return (
        <View className="flex-1 items-center justify-center p-12">
          <Icon as={FileIcon} size={48} className="text-primary opacity-50 mb-4" />
          <Text className="text-sm text-primary opacity-50">No source code to display</Text>
        </View>
      );
    }

    // Use contentLines which is already computed from fileContent
    if (contentLines.length === 0) {
      return (
        <View className="flex-1 items-center justify-center p-12">
          <Icon as={FileIcon} size={48} className="text-primary opacity-50 mb-4" />
          <Text className="text-sm text-primary opacity-50">No content to display</Text>
        </View>
      );
    }

    return (
      <ScrollView
        ref={sourceScrollRef}
        className="flex-1"
        showsVerticalScrollIndicator={true}
        nestedScrollEnabled={true}
        onScroll={handleSourceScroll}
        scrollEventThrottle={16}
      >
        <View className="p-2 bg-card">
          {contentLines.map((line, idx) => (
            <View key={idx} className="flex-row" style={{ minHeight: 22 }}>
              <View
                className="w-10 items-end pr-3 py-0.5 border-r border-border"
              >
                <Text
                  className="text-[11px] font-roobert-mono text-primary opacity-50"
                >
                  {idx + 1}
                </Text>
              </View>
              <View className="flex-1 pl-3 py-0.5">
                <Text
                  className="text-[13px] font-roobert-mono leading-5 text-primary"
                  selectable
                >
                  {line || ' '}
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
  const hasDiffData = isStrReplace && oldStr && newStr;

  // Initialize activeTab for str-replace with diff data (only once)
  useEffect(() => {
    if (!tabInitializedRef.current) {
      if (hasDiffData) {
        setActiveTab('changes');
      } else if (isMarkdown || isJson || isHtml || isCsv || isXlsx || isPresentationSlide) {
        setActiveTab('preview');
      } else {
        setActiveTab('code');
      }
      tabInitializedRef.current = true;
    }
  }, [hasDiffData, isMarkdown, isHtml, isCsv, isXlsx, isPresentationSlide]);

  // Loading state
  if (isStreaming && !fileContent && !filePath && !oldStr) {
    return (
      <ToolViewCard
        header={{
          icon: HeaderIcon,
          iconColor: headerIconColor,
          iconBgColor: headerBgColor,
          subtitle: '',
          title: displayTitle,
          isSuccess: actualIsSuccess,
          isStreaming: true,
          rightContent: <StatusBadge variant="streaming" label="Processing" />,
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

  // Delete operation
  if (operation === 'delete') {
    return (
      <ToolViewCard
        header={{
          icon: OperationIcon,
          iconColor: config.color,
          iconBgColor: config.bgColor,
          subtitle: '',
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
          <View className="bg-card rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
            <Icon as={OperationIcon} size={40} className="text-primary" strokeWidth={2} />
          </View>
          <Text className="text-xl font-roobert-semibold mb-6 text-primary">
            File Deleted
          </Text>
          {processedFilePath && (
            <View className="bg-card border border-border rounded-xl p-4 w-full max-w-md mb-4">
              <Text className="text-sm font-roobert-mono text-primary text-center" numberOfLines={3}>
                {processedFilePath}
              </Text>
            </View>
          )}
          <Text className="text-sm text-primary opacity-50 text-center">
            This file has been permanently removed
          </Text>
        </View>
      </ToolViewCard>
    );
  }

  // Build tabs - always show Source/Preview, add Changes for str-replace
  const tabs = [
    { id: 'code', label: 'Source', icon: Code },
    { id: 'preview', label: 'Preview', icon: Eye },
  ];
  if (hasDiffData) {
    tabs.push({ id: 'changes', label: 'Changes', icon: FileDiff });
  }

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
        showStatus: true,
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          <View className="flex-row items-center gap-2">
            {processedFilePath && (
              <View className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full border border-border">
                <Icon as={FileText} size={12} className="text-primary" />
                <Text className="text-xs font-roobert-medium text-primary" numberOfLines={1}>
                  {fileName || 'File'}
                </Text>
              </View>
            )}
            <View className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full border border-border">
              <Icon as={FileIcon} size={12} className="text-primary" />
              <Text className="text-xs font-roobert-medium text-primary">
                {hasHighlighting ? language.toUpperCase() : fileExtension.toUpperCase() || 'TEXT'}
              </Text>
            </View>
          </View>
          {toolTimestamp && !isStreaming && (
            <Text className="text-xs text-primary opacity-50">
              {formatTimestamp(toolTimestamp)}
            </Text>
          )}
        </View>
      }
    >
      {/* Toolbar section for tabs and actions */}
      {!isStreaming && (tabs.length > 1 || hasDiffData || fileContent || processedFilePath) && (
        <View className="px-4 py-3 border-b border-border bg-card flex-row items-center justify-between gap-3">
          <View className="flex-row items-center gap-2 flex-1">
            {tabs.length > 1 && (
              <TabSwitcher
                tabs={tabs}
                activeTab={activeTab}
                onTabChange={(tabId) => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setActiveTab(tabId as 'code' | 'preview' | 'changes');
                }}
                iconOnly={true}
              />
            )}
            {hasDiffData && (
              <View className="flex-row items-center gap-1.5 px-2 py-1 rounded-full bg-card border border-border">
                <Icon as={Plus} size={12} className="text-primary" />
                <Text className="text-xs font-roobert-medium text-primary">{diffStats.additions}</Text>
                <Icon as={Minus} size={12} className="text-primary" />
                <Text className="text-xs font-roobert-medium text-primary">{diffStats.deletions}</Text>
              </View>
            )}
          </View>
          <View className="flex-row items-center gap-2">
            {fileContent && !isPresentationSlide && (
              <FileDownloadButton
                content={fileContent}
                fileName={fileName || 'file.txt'}
                disabled={isStreaming}
              />
            )}
            {fileContent && !isPresentationSlide && (
              <Pressable
                onPress={handleCopyContent}
                disabled={isCopyingContent}
                className="h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70"
              >
                <Icon
                  as={isCopyingContent ? Check : Copy}
                  size={17}
                  className="text-primary"
                />
              </Pressable>
            )}
            {processedFilePath && !isPresentationSlide && (
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  openFileInComputer(processedFilePath);
                }}
                className="h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70"
              >
                <Icon as={Pencil} size={17} className="text-primary" />
              </Pressable>
            )}
          </View>
        </View>
      )}

      <View className="flex-1 w-full">
        {activeTab === 'code' ? (
          renderSourceCode()
        ) : activeTab === 'changes' ? (
          renderDiffView()
        ) : (
          renderFilePreview()
        )}
      </View>
    </ToolViewCard>
  );
}

