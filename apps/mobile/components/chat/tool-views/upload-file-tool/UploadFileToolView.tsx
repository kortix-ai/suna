import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Upload, CheckCircle2, AlertCircle, FileText, HardDrive } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractUploadFileData } from './_utils';

export function UploadFileToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { filePath, fileName, fileSize, message, success } = extractUploadFileData(toolData);

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return '';
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  };

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-blue-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Upload} size={40} className="text-blue-500 animate-pulse" />
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
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-blue-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Upload} size={24} className="text-blue-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              File Upload
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              {fileName || 'File'}
            </Text>
          </View>
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
              {success ? 'Uploaded' : 'Failed'}
            </Text>
          </View>
        </View>

        {filePath && (
          <View className="bg-card border border-border rounded-xl p-4 gap-3">
            <View className="flex-row items-center gap-2">
              <Icon as={FileText} size={16} className="text-muted-foreground" />
              <Text className="text-sm font-roobert-medium text-muted-foreground">
                File Path
              </Text>
            </View>
            <Text className="text-sm font-roobert-mono text-foreground" selectable>
              {filePath}
            </Text>
          </View>
        )}

        {fileSize && (
          <View className="bg-muted/30 rounded-xl p-3 border border-border">
            <View className="flex-row items-center gap-2 mb-1">
              <Icon as={HardDrive} size={14} className="text-muted-foreground" />
              <Text className="text-xs font-roobert-medium text-muted-foreground">
                File Size
              </Text>
            </View>
            <Text className="text-lg font-roobert-semibold text-foreground">
              {formatFileSize(fileSize)}
            </Text>
          </View>
        )}

        {message && (
          <View className="bg-muted/50 rounded-xl p-4 border border-border">
            <Text className="text-sm font-roobert text-foreground">
              {message}
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

