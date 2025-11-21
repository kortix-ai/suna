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
  toolData,
  isStreaming = false
}: ToolViewProps) {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'source' | 'preview'>('source');

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

    if (fileContent && typeof fileContent !== 'string') {
      fileContent = JSON.stringify(fileContent, null, 2);
    }
  } else if (operation === 'edit' || operation === 'str-replace') {
    if (toolData.result?.output) {
      const output = parseContent(toolData.result.output);

      if (output && typeof output === 'object' && output.updated_content) {
        fileContent = output.updated_content;
      } else if (output && typeof output === 'object' && output.new_content) {
        fileContent = output.new_content;
      } else if (typeof output === 'string' && !output.toLowerCase().includes('successfully')) {
        fileContent = output;
      }
    }

    if (!fileContent) {
      fileContent = toolData.arguments?.new_str ||
        toolData.arguments?.new_string ||
        toolData.arguments?.new_content ||
        toolData.arguments?.code_edit ||
        null;
    }
  }

  const processedFilePath = processFilePath(filePath);
  const fileName = getFileName(processedFilePath);
  const fileExtension = getFileExtension(fileName);

  const isMarkdown = isFileType.markdown(fileExtension);
  const isJson = isFileType.json(fileExtension);
  const hasPreview = isMarkdown;

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