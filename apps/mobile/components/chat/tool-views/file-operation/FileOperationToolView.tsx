import React, { useState, useMemo, useRef, useEffect } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { WebView } from 'react-native-webview';
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
  generateEmptyLines,
  generateLineDiff,
  calculateDiffStats,
  type LineDiff,
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
  const [activeTab, setActiveTab] = useState<'code' | 'preview' | 'changes'>('preview');
  const sourceScrollRef = useRef<ScrollView>(null);
  const previewScrollRef = useRef<ScrollView>(null);
  const lastLineCountRef = useRef<number>(0);
  const tabInitializedRef = useRef<boolean>(false);

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
    console.log('[FileOperationToolView] Content extraction:', {
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

  // Auto-scroll during streaming
  useEffect(() => {
    if (!isStreaming || !fileContent || !sourceScrollRef.current) return;
    const currentLineCount = contentLines.length;
    if (currentLineCount <= lastLineCountRef.current) return;
    lastLineCountRef.current = currentLineCount;
    setTimeout(() => {
      sourceScrollRef.current?.scrollToEnd({ animated: false });
    }, 100);
  }, [isStreaming, contentLines.length, fileContent]);

  useEffect(() => {
    if (!isStreaming) {
      lastLineCountRef.current = 0;
    }
  }, [isStreaming]);

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

  const renderDiffView = () => {
    if (!oldStr || !newStr) {
      return (
        <View className="flex-1 items-center justify-center p-8">
          <View className="bg-primary/10 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
            <Icon as={Check} size={32} className="text-primary" />
          </View>
          <Text className="text-sm font-roobert-medium text-foreground">Replacement Complete</Text>
          <Text className="text-xs text-muted-foreground mt-1">{processedFilePath}</Text>
        </View>
      );
    }

    return (
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="p-2">
          {lineDiff.map((line, idx) => {
            if (line.type === 'unchanged') return null;
            
            const bgColor = line.type === 'added' 
              ? (isDark ? 'rgba(34, 197, 94, 0.1)' : 'rgba(34, 197, 94, 0.1)')
              : (isDark ? 'rgba(239, 68, 68, 0.1)' : 'rgba(239, 68, 68, 0.1)');
            const borderColor = line.type === 'added'
              ? (isDark ? 'rgba(34, 197, 94, 0.3)' : 'rgba(34, 197, 94, 0.3)')
              : (isDark ? 'rgba(239, 68, 68, 0.3)' : 'rgba(239, 68, 68, 0.3)');

            return (
              <View
                key={idx}
                className="flex-row items-start mb-1 rounded-lg overflow-hidden"
                style={{ 
                  backgroundColor: bgColor,
                  borderLeftWidth: 3,
                  borderLeftColor: borderColor,
                }}
              >
                <View className="w-8 items-center justify-center py-2">
                  <Icon
                    as={line.type === 'added' ? Plus : Minus}
                    size={12}
                    className={line.type === 'added' ? 'text-green-500' : 'text-red-500'}
                  />
                </View>
                <View className="w-10 items-end justify-center pr-2 py-2">
                  <Text className="text-[10px] font-roobert-mono text-muted-foreground">
                    {line.lineNumber}
                  </Text>
                </View>
                <View className="flex-1 py-2 pr-3">
                  <Text
                    className={`text-xs font-roobert-mono ${
                      line.type === 'added' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                    }`}
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
              onFullScreenClick={() => {}}
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
        <ScrollView ref={previewScrollRef} className="flex-1" showsVerticalScrollIndicator={false}>
          <View className="p-4">
            <MarkdownRenderer content={processUnicodeContent(fileContent)} />
          </View>
        </ScrollView>
      );
    }

    if (isCsv) {
      return (
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          <View className="p-4">
            <CsvRenderer content={processUnicodeContent(fileContent)} />
          </View>
        </ScrollView>
      );
    }

    if (isXlsx) {
      return (
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          <View className="p-4">
            <XlsxRenderer content={fileContent} fileName={fileName} />
          </View>
        </ScrollView>
      );
    }

    // Default: Code preview
    return (
      <ScrollView ref={previewScrollRef} className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="p-2">
          <CodeRenderer
            code={processUnicodeContent(fileContent)}
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
          <Icon as={FileIcon} size={48} className="text-muted-foreground mb-4" />
          <Text className="text-sm text-muted-foreground">No source code to display</Text>
        </View>
      );
    }

    // Use contentLines which is already computed from fileContent
    if (contentLines.length === 0) {
      return (
        <View className="flex-1 items-center justify-center p-12">
          <Icon as={FileIcon} size={48} className="text-muted-foreground mb-4" />
          <Text className="text-sm text-muted-foreground">No content to display</Text>
        </View>
      );
    }

    return (
      <ScrollView ref={sourceScrollRef} className="flex-1" showsVerticalScrollIndicator={false}>
        <View 
          className="p-2"
          style={{
            backgroundColor: isDark ? '#1a1a1a' : '#fafafa',
          }}
        >
          {contentLines.map((line, idx) => (
            <View key={idx} className="flex-row" style={{ minHeight: 22 }}>
              <View 
                className="w-10 items-end pr-3 py-0.5"
                style={{
                  borderRightWidth: 1,
                  borderRightColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
                }}
              >
                <Text 
                  className="text-[11px] font-roobert-mono"
                  style={{ color: isDark ? '#666' : '#999' }}
                >
                  {idx + 1}
                </Text>
              </View>
              <View className="flex-1 pl-3 py-0.5">
                <Text
                  className="text-[13px] font-roobert-mono leading-5"
                  style={{ color: isDark ? '#e0e0e0' : '#333' }}
                  selectable
                >
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
  const hasDiffData = isStrReplace && oldStr && newStr;
  
  // Initialize activeTab for str-replace with diff data (only once)
  useEffect(() => {
    if (hasDiffData && !tabInitializedRef.current) {
      setActiveTab('changes');
      tabInitializedRef.current = true;
    }
  }, [hasDiffData]);

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
        rightContent: (
          <View className="flex-row items-center gap-2">
            {tabs.length > 1 && (
              <TabSwitcher
                tabs={tabs}
                activeTab={activeTab}
                onTabChange={(tabId) => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setActiveTab(tabId as 'code' | 'preview' | 'changes');
                }}
              />
            )}
            {hasDiffData && (
              <View className="flex-row items-center gap-1.5 px-2 py-1 rounded-lg" style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                <Icon as={Plus} size={12} className="text-green-500" />
                <Text className="text-xs font-roobert-medium text-green-500">{diffStats.additions}</Text>
                <Icon as={Minus} size={12} className="text-red-500" style={{ marginLeft: 4 }} />
                <Text className="text-xs font-roobert-medium text-red-500">{diffStats.deletions}</Text>
              </View>
            )}
            {fileContent && !isStreaming && !isPresentationSlide && (
              <Pressable
                onPress={handleCopyContent}
                disabled={isCopyingContent}
                className="h-8 w-8 items-center justify-center rounded-lg active:opacity-70"
                style={{ backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)' }}
              >
                <Icon
                  as={isCopyingContent ? Check : Copy}
                  size={16}
                  className={isCopyingContent ? 'text-primary' : 'text-foreground'}
                />
              </Pressable>
            )}
            {processedFilePath && !isStreaming && !isPresentationSlide && (
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
                style={{ borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)' }}
              >
                <Icon as={FileText} size={12} className="text-foreground" />
                <Text className="text-xs font-roobert-medium text-foreground" numberOfLines={1}>
                  {fileName || 'File'}
                </Text>
              </View>
            )}
            <View
              className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full border"
              style={{ borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)' }}
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
