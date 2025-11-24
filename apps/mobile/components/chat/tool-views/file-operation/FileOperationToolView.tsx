import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, AlertCircle, Copy, Check, FileText, Code, Eye } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import {
  getOperationType,
  getOperationConfigs,
  getOperationTitle,
  processFilePath,
  getFileName,
  getFileExtension,
  isFileType,
} from './_utils';
import { MarkdownRenderer } from './MarkdownRenderer';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';


export function FileOperationToolView({ 
  toolCall,
  toolResult,
  isStreaming = false,
  isSuccess = true,
}: ToolViewProps) {
  if (!toolCall) {
    return null;
  }

  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'source' | 'preview'>('source');

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const operation = getOperationType(name);
  const configs = getOperationConfigs();
  const config = configs[operation];
  const OperationIcon = config.icon;

  // Extract from toolCall.arguments
  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => {
          try {
            return JSON.parse(toolCall.arguments);
          } catch {
            return {};
          }
        })()
      : {};

  let filePath: string | null = args.file_path || 
                                args.path || 
                                args.target_path ||
                                args.target_file ||
                                args.filename ||
                                null;

  let fileContent: string | null = null;

  // Extract from toolResult.output
  if (toolResult?.output) {
    let output: any = toolResult.output;
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output);
      } catch {
        // Keep as string if not JSON
      }
    }

    if (operation === 'read') {
      if (typeof output === 'string') {
        const lowerOutput = output.toLowerCase();
        if (!lowerOutput.includes('successfully') || output.length > 200) {
          fileContent = output;
        }
      } else if (output && typeof output === 'object') {
        fileContent = output.content || output.data || JSON.stringify(output, null, 2);
      }
    } else if (operation === 'edit' || operation === 'str-replace') {
      if (output && typeof output === 'object') {
        fileContent = output.updated_content || output.new_content || null;
      } else if (typeof output === 'string' && !output.toLowerCase().includes('successfully')) {
        fileContent = output;
      }
    }
  }

  // Extract from arguments for create/rewrite/edit operations
  if (!fileContent) {
    if (operation === 'create' || operation === 'rewrite') {
      fileContent = args.file_contents ||  
                    args.content || 
                    args.contents || 
                    args.file_content ||
                    args.text ||
                    args.data ||
                    null;
      
      if (fileContent && typeof fileContent !== 'string') {
        fileContent = JSON.stringify(fileContent, null, 2);
      }
    } else if (operation === 'edit' || operation === 'str-replace') {
      fileContent = args.new_str || 
                    args.new_string || 
                    args.new_content ||
                    args.code_edit ||
                    null;
    }
  }

  // Process file info
  const processedFilePath = processFilePath(filePath);
  const fileName = getFileName(processedFilePath);
  const fileExtension = getFileExtension(fileName);

  const isMarkdown = isFileType.markdown(fileExtension);
  const isJson = isFileType.json(fileExtension);
  const hasPreview = isMarkdown;
  const success = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  const handleCopy = async () => {
    if (!fileContent) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await Clipboard.setStringAsync(fileContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const switchViewMode = (mode: 'source' | 'preview') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setViewMode(mode);
  };

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className={`${config.bgColor} rounded-2xl items-center justify-center mb-6`} style={{ width: 80, height: 80 }}>
          <Icon as={OperationIcon} size={40} className={`${config.color} animate-pulse`} />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          {getOperationTitle(operation)}
        </Text>
        {filePath && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3">
            <Text className="text-sm font-roobert-mono text-foreground/60 text-center" numberOfLines={2}>
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
        <Text className="text-base font-roobert-medium text-foreground mb-1">
          No File Path
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          Unable to extract file information
        </Text>
      </View>
    );
  }

  const renderContent = () => {
    if (!fileContent) return null;

    if (viewMode === 'preview' && isMarkdown) {
      return (
        <View className="bg-card border border-border rounded-2xl p-4">
          <MarkdownRenderer content={fileContent} />
        </View>
      );
    }

    // Source view - format JSON if applicable
    let displayContent = fileContent;
    if (isJson) {
      try {
        const parsed = JSON.parse(fileContent);
        displayContent = JSON.stringify(parsed, null, 2);
      } catch {
        // Use original content if JSON parsing fails
      }
    }

    const lines = displayContent.split('\n');
    return (
      <View className="bg-card border border-border rounded-2xl p-4">
        {lines.map((line, idx) => (
          <Text
            key={idx}
            className="text-xs font-roobert-mono text-foreground/80 leading-5"
            selectable
          >
            {line || ' '}
          </Text>
        ))}
      </View>
    );
  };

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className={`${config.bgColor} rounded-2xl items-center justify-center`} style={{ width: 48, height: 48 }}>
            <Icon as={OperationIcon} size={24} className={config.color} />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              {getOperationTitle(operation)}
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              {fileName}
            </Text>
          </View>
        </View>

        {fileContent && operation !== 'delete' ? (
          <View className="gap-3">
            <View className="flex-row items-center gap-2">
              {hasPreview && (
                <>
                  <Button
                    variant={viewMode === 'source' ? 'default' : 'outline'}
                    size="sm"
                    onPress={() => switchViewMode('source')}
                    className="flex-1 rounded-2xl"
                  >
                    <Text>Source</Text>
                  </Button>

                  <Button
                    variant={viewMode === 'preview' ? 'default' : 'outline'}
                    size="sm"
                    onPress={() => switchViewMode('preview')}
                    className="flex-1 rounded-2xl"
                  >
                    <Text>Preview</Text>
                  </Button>
                </>
              )}

              <Button
                variant="outline"
                size="sm"
                onPress={handleCopy}
                className={`rounded-2xl ${hasPreview ? '' : 'flex-1'}`}
              >
                <Text>{copied ? 'Copied!' : 'Copy'}</Text>
              </Button>
            </View>

            {renderContent()}
          </View>
        ) : operation === 'delete' ? (
          <View className="py-8 items-center">
            <View className="bg-destructive/10 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
              <Icon as={OperationIcon} size={32} className="text-destructive" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              File Deleted
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              This file has been removed
            </Text>
          </View>
        ) : (
          <View className="py-8 items-center">
            <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
              <Icon as={FileText} size={32} className="text-muted-foreground" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              No Content
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              No content available to display
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}