import React, { useState } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, AlertCircle, Copy, Check, Code, Eye, FileText, Loader2 } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import {
  getLanguageFromFileName,
  getOperationType,
  getOperationConfigs,
  getOperationTitle,
  getFileIcon,
  processFilePath,
  getFileName,
  getFileExtension,
  isFileType,
  hasLanguageHighlighting,
  splitContentIntoLines,
  generateEmptyLines,
  extractFilePath,
  extractFileContent,
  extractStreamingFileContent,
  extractToolData,
} from './_utils';
import { MarkdownRenderer } from './MarkdownRenderer';
import { CsvRenderer } from './CsvRenderer';
import { XlsxRenderer } from './XlsxRenderer';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';


export function FileOperationToolView({ 
  toolData, 
  isStreaming = false, 
  assistantMessage,
  toolMessage 
}: ToolViewProps) {
  const [copied, setCopied] = useState(false);
  const [showFullContent, setShowFullContent] = useState(false);
  const [activeTab, setActiveTab] = useState<'source' | 'preview'>('preview');

  const parseContent = (content: any): any => {
    if (typeof content === 'string') {
      try {
        return JSON.parse(content);
      } catch (e) {
        return content;
      }
    }
    return content;
  };

  const operation = getOperationType(toolData.toolName);
  const configs = getOperationConfigs();
  const config = configs[operation];
  const OperationIcon = config.icon;

  let filePath: string | null = null;
  let fileContent: string | null = null;

  filePath = toolData.arguments?.file_path || 
             toolData.arguments?.path || 
             toolData.arguments?.target_path ||
             toolData.arguments?.target_file ||
             toolData.arguments?.filename ||
             null;

  if (operation === 'read') {
    if (toolData.result?.output) {
      const output = parseContent(toolData.result.output);
      
      if (typeof output === 'string') {
        const lowerOutput = output.toLowerCase();
        if (!lowerOutput.includes('successfully') || output.length > 200) {
          fileContent = output;
        }
      } else if (output && typeof output === 'object') {
        fileContent = output.content || output.data || JSON.stringify(output, null, 2);
      }
    }
  } else if (operation === 'create' || operation === 'rewrite') {
    fileContent = toolData.arguments?.file_contents ||  
                  toolData.arguments?.content || 
                  toolData.arguments?.contents || 
                  toolData.arguments?.file_content ||
                  toolData.arguments?.text ||
                  toolData.arguments?.data ||
                  null;
    
    // Ensure it's a string
    if (fileContent && typeof fileContent !== 'string') {
      fileContent = JSON.stringify(fileContent, null, 2);
    }
  } else if (operation === 'edit' || operation === 'str-replace') {
    // For edit/str-replace, check result.output.updated_content first
    if (toolData.result?.output) {
      const output = parseContent(toolData.result.output);
      
      // Check for updated_content in the output object
      if (output && typeof output === 'object' && output.updated_content) {
        fileContent = output.updated_content;
      } else if (output && typeof output === 'object' && output.new_content) {
        fileContent = output.new_content;
      } else if (typeof output === 'string' && !output.toLowerCase().includes('successfully')) {
        fileContent = output;
      }
    }
    
    // If still no content, check arguments
    if (!fileContent) {
      fileContent = toolData.arguments?.new_str || 
                    toolData.arguments?.new_string || 
                    toolData.arguments?.new_content ||
                    toolData.arguments?.code_edit ||  // Sometimes edit content is in code_edit
                    null;
    }
  }

  // If still no content for non-delete operations, try to extract from messages as fallback
  if (!fileContent && operation !== 'delete' && assistantMessage?.content) {
    const assistantContent = assistantMessage.content;
    const toolName = operation === 'create' ? 'create-file' : 
                    operation === 'edit' ? 'edit-file' : 
                    operation === 'rewrite' ? 'full-file-rewrite' : 'read-file';
    
    fileContent = isStreaming
      ? extractStreamingFileContent(assistantContent, toolName) || ''
      : extractFileContent(assistantContent, toolName);
  }

  // Debug logging
  if (!fileContent && operation !== 'delete' && !isStreaming) {
    console.log('FileOperationToolView - Debug:', {
      operation,
      toolName: toolData.toolName,
      arguments: toolData.arguments,
      resultOutput: toolData.result?.output,
      resultType: typeof toolData.result?.output,
      filePath
    });
  }

  // Process file info
  const processedFilePath = processFilePath(filePath);
  const fileName = getFileName(processedFilePath);
  const fileExtension = getFileExtension(fileName);
  
  const isMarkdown = isFileType.markdown(fileExtension);
  const isHtml = isFileType.html(fileExtension);
  const isCsv = isFileType.csv(fileExtension);
  const isXlsx = isFileType.xlsx(fileExtension);
  const isJson = isFileType.json(fileExtension);
  const isCode = !isMarkdown && !isHtml && !isCsv && !isXlsx && !isJson;
  
  const language = getLanguageFromFileName(fileName);
  const hasHighlighting = hasLanguageHighlighting(language);
  const contentLines = splitContentIntoLines(fileContent);
  const lineCount = contentLines.length;
  const charCount = fileContent?.length || 0;
  
  const FileIcon = getFileIcon(fileName);
  const success = toolData.result?.success !== false;

  const handleCopy = async () => {
    if (!fileContent) return;
    
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await Clipboard.setStringAsync(fileContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleContent = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowFullContent(!showFullContent);
  };

  const switchTab = (tab: 'source' | 'preview') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActiveTab(tab);
  };

  const truncateContent = (content: string | null, maxLines: number = 50): string => {
    if (!content) return '';
    const lines = content.split('\n');
    if (lines.length <= maxLines) return content;
    return lines.slice(0, maxLines).join('\n') + '\n... (truncated)';
  };

  const displayContent = showFullContent 
    ? fileContent 
    : fileContent && lineCount > 50 
      ? truncateContent(fileContent) 
      : fileContent;

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-primary/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
        <ActivityIndicator size="large" color="#0066FF" />
      </View>
      <Text className="text-xl font-roobert-semibold text-foreground mb-2">
        {getOperationTitle(operation)}
      </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          Processing file...
        </Text>
        {filePath && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3 w-full">
            <Text className="text-xs font-roobert-medium text-foreground/60 text-center" numberOfLines={2}>
              {filePath}
            </Text>
          </View>
        )}
      </View>
    );
  }

  if (!filePath) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={AlertCircle} size={40} className="text-muted-foreground" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          No File Path
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          Unable to extract file information
        </Text>
      </View>
    );
  }

  const processUnicodeContent = (text: string): string => {
    if (!text) return '';
    return text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\r\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\\t/g, '  ');
  };

  const formatJson = (content: string): string | null => {
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return null;
    }
  };

  const renderSourceView = () => {
    if (!fileContent) {
      return (
        <View className="items-center justify-center py-12">
          <Icon as={FileText} size={48} className="text-muted-foreground mb-3" />
          <Text className="text-sm font-roobert text-muted-foreground">
            No content to display
          </Text>
        </View>
      );
    }

    // Format JSON files
    let formattedContent = displayContent;
    if (isJson && fileContent) {
      const formatted = formatJson(fileContent);
      if (formatted) {
        formattedContent = showFullContent ? formatted : truncateContent(formatted);
      }
    }

    return (
      <View className="bg-muted/5 border border-border rounded-2xl overflow-hidden">
        <View className="bg-muted/30 px-4 py-2 border-b border-border flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <Icon as={Code} size={14} className="text-foreground/50" />
            <Text className="text-xs font-roobert-medium text-foreground/60">
              {language.toUpperCase()}
            </Text>
          </View>
          <Text className="text-xs font-roobert text-foreground/40">
            {lineCount} lines • {charCount} chars
          </Text>
        </View>
        <ScrollView 
          className="p-4" 
          style={{ maxHeight: 400 }}
          showsVerticalScrollIndicator={true}
        >
          <Text className="text-xs font-mono text-foreground/80 leading-5" selectable>
            {processUnicodeContent(formattedContent || '')}
          </Text>
        </ScrollView>
        {lineCount > 50 && (
          <Pressable 
            onPress={toggleContent} 
            className="bg-muted/30 px-4 py-2 border-t border-border items-center"
          >
            <Text className="text-xs font-roobert-medium text-primary">
              {showFullContent ? 'Show Less' : `Show All (${lineCount} lines)`}
            </Text>
          </Pressable>
        )}
      </View>
    );
  };

  const renderPreviewView = () => {
    if (!fileContent) {
      return (
        <View className="items-center justify-center py-12">
          <Icon as={Eye} size={48} className="text-muted-foreground mb-3" />
          <Text className="text-sm font-roobert text-muted-foreground">
            No content to preview
          </Text>
        </View>
      );
    }

    const processedContent = processUnicodeContent(fileContent);

    // For HTML files, show raw HTML
    if (isHtml) {
      return (
        <View className="bg-card border border-border rounded-2xl p-4">
          <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={true}>
            <Text className="text-xs font-mono text-foreground/90 leading-5">
              {processedContent}
            </Text>
          </ScrollView>
        </View>
      );
    }

    // For CSV files, use CSV renderer
    if (isCsv) {
      return <CsvRenderer content={processedContent} />;
    }

    // For XLSX files, use XLSX renderer
    if (isXlsx) {
      return <XlsxRenderer content={processedContent} fileName={fileName} />;
    }

    // For JSON files, show formatted
    if (isJson) {
      const formatted = formatJson(processedContent);
      if (formatted) {
        return (
          <View className="bg-card border border-border rounded-2xl p-4">
            <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={true}>
              <Text className="text-xs font-mono text-foreground/90 leading-5">
                {formatted}
              </Text>
            </ScrollView>
          </View>
        );
      }
    }

    // For markdown files, use markdown renderer
    if (isMarkdown) {
      return (
        <View className="bg-card border border-border rounded-2xl overflow-hidden">
          <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={true}>
            <MarkdownRenderer content={processedContent} />
          </ScrollView>
        </View>
      );
    }

    // For other files, show the same as source but with better formatting
    return (
      <View className="bg-card border border-border rounded-2xl p-4">
        <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={true}>
          <Text className="text-sm font-roobert text-foreground/90 leading-6">
            {processUnicodeContent(displayContent || '')}
          </Text>
        </ScrollView>
      </View>
    );
  };

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className={`rounded-2xl items-center justify-center ${
            operation === 'delete' ? 'bg-destructive/10' : 'bg-primary/10'
          }`} style={{ width: 48, height: 48 }}>
            <Icon 
              as={OperationIcon} 
              size={24} 
              className={config.color} 
            />
          </View>
          <View className="flex-1">
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              {getOperationTitle(operation)}
            </Text>
          </View>
          {!isStreaming && (
            <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${
              success ? 'bg-primary/10' : 'bg-destructive/10'
            }`}>
              <Icon 
                as={success ? CheckCircle2 : AlertCircle} 
                size={12} 
                className={success ? 'text-primary' : 'text-destructive'} 
              />
              <Text className={`text-xs font-roobert-medium ${
                success ? 'text-primary' : 'text-destructive'
              }`}>
                {success ? 'Done' : 'Failed'}
              </Text>
            </View>
          )}
        </View>
        {fileContent && operation !== 'delete' && (
          <View className="gap-3">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                <Pressable
                  onPress={() => switchTab('source')}
                  className={`px-4 py-2 rounded-lg ${
                    activeTab === 'source' 
                      ? 'bg-primary/10' 
                      : 'bg-muted/30'
                  }`}
                >
                  <View className="flex-row items-center gap-2">
                    <Icon 
                      as={Code} 
                      size={14} 
                      className={activeTab === 'source' ? 'text-primary' : 'text-foreground/60'} 
                    />
                    <Text className={`text-sm font-roobert-medium ${
                      activeTab === 'source' ? 'text-primary' : 'text-foreground/60'
                    }`}>
                      Source
                    </Text>
                  </View>
                </Pressable>
                
                <Pressable
                  onPress={() => switchTab('preview')}
                  className={`px-4 py-2 rounded-lg ${
                    activeTab === 'preview' 
                      ? 'bg-primary/10' 
                      : 'bg-muted/30'
                  }`}
                >
                  <View className="flex-row items-center gap-2">
                    <Icon 
                      as={Eye} 
                      size={14} 
                      className={activeTab === 'preview' ? 'text-primary' : 'text-foreground/60'} 
                    />
                    <Text className={`text-sm font-roobert-medium ${
                      activeTab === 'preview' ? 'text-primary' : 'text-foreground/60'
                    }`}>
                      Preview
                    </Text>
                  </View>
                </Pressable>
              </View>

              <Pressable
                onPress={handleCopy}
                className="flex-row items-center gap-1.5 bg-muted/30 px-3 py-2 rounded-lg"
              >
                <Icon 
                  as={copied ? Check : Copy} 
                  size={14} 
                  className={copied ? 'text-primary' : 'text-foreground/60'} 
                />
                <Text className={`text-xs font-roobert-medium ${
                  copied ? 'text-primary' : 'text-foreground/60'
                }`}>
                  {copied ? 'Copied!' : 'Copy'}
                </Text>
              </Pressable>
            </View>
            {activeTab === 'source' ? renderSourceView() : renderPreviewView()}
          </View>
        )}
        {operation === 'delete' && (
          <View className="items-center justify-center py-8 bg-destructive/5 rounded-2xl border border-destructive/20">
            <Icon as={OperationIcon} size={48} className="text-destructive mb-3" />
            <Text className="text-lg font-roobert-semibold text-foreground mb-2">
              File Deleted
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center px-4">
              This file has been permanently removed from the system
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}