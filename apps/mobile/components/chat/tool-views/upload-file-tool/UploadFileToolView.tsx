import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Upload, CheckCircle2, AlertCircle, FileText, HardDrive } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractUploadFileData } from './_utils';

export function UploadFileToolView({ toolCall, toolResult, isStreaming = false }: ToolViewProps) {
  const { filePath, fileName, fileSize, message, success } = extractUploadFileData({ toolCall, toolResult });

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return '';
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  };

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-background rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Upload} size={40} className="text-primary animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Uploading File
        </Text>
        {fileName && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3">
            <Text className="text-sm font-roobert text-foreground/60 text-center" numberOfLines={2}>
              {fileName}
            </Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <View className="px-6 gap-6">
      {filePath && (
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            File Path
          </Text>
          <View className="bg-card border border-border rounded-2xl p-4">
            <Text className="text-sm font-roobert-mono text-foreground" selectable>
              {filePath}
            </Text>
          </View>
        </View>
      )}

      {fileSize && (
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            File Size
          </Text>
          <View className="bg-card border border-border rounded-2xl p-4">
            <Text className="text-lg font-roobert-semibold text-foreground">
              {formatFileSize(fileSize)}
            </Text>
          </View>
        </View>
      )}

      {message && (
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            Message
          </Text>
          <View className="bg-card border border-border rounded-2xl p-4">
            <Text className="text-sm font-roobert text-foreground" selectable>
              {message}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

