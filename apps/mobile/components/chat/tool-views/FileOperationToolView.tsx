/**
 * File Operation Tool View
 * 
 * Specialized view for file operations: create, read, edit, delete
 */

import React, { useState } from 'react';
import { View, ScrollView, Pressable, Clipboard } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import * as Haptics from 'expo-haptics';
import { 
  File, 
  FileText, 
  FileEdit, 
  Trash2, 
  CheckCircle2, 
  AlertCircle,
  Copy,
  Check,
  Eye,
  Code
} from 'lucide-react-native';
import type { ToolViewProps } from './types';

const OPERATION_CONFIGS = {
  'create-file': { icon: File, label: 'File Created', color: 'primary' },
  'read-file': { icon: Eye, label: 'File Read', color: 'primary' },
  'edit-file': { icon: FileEdit, label: 'File Edited', color: 'primary' },
  'delete-file': { icon: Trash2, label: 'File Deleted', color: 'destructive' },
  'full-file-rewrite': { icon: FileEdit, label: 'File Rewritten', color: 'primary' },
};


export function FileOperationToolView({ toolData }: ToolViewProps) {
  const { toolName, arguments: toolArgs, result } = toolData;
  const [copied, setCopied] = useState(false);

  const config = OPERATION_CONFIGS[toolName as keyof typeof OPERATION_CONFIGS] || OPERATION_CONFIGS['create-file'];
  const OperationIcon = config.icon;
  const isError = !result.success;

  const filePath = toolArgs.file_path || toolArgs.path || '';
  const fileContent = toolArgs.content || toolArgs.new_content || '';
  const fileName = filePath.split('/').pop() || filePath;
  const fileExtension = fileName.split('.').pop() || '';

  const handleCopy = async () => {
    if (fileContent) {
      Clipboard.setString(fileContent);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      console.log('📋 Copied file content to clipboard');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <View className="px-6 py-4 gap-6">
      {/* Header */}
      <View className="flex-row items-center gap-3">
        <View className={`rounded-2xl items-center justify-center ${
          config.color === 'destructive' ? 'bg-destructive/10' : 'bg-primary/10'
        }`} style={{ width: 48, height: 48 }}>
          <Icon 
            as={OperationIcon} 
            size={24} 
            className={config.color === 'destructive' ? 'text-destructive' : 'text-primary'} 
          />
        </View>
        <View className="flex-1">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
            File Operation
          </Text>
          <Text className="text-xl font-roobert-semibold text-foreground">
            {config.label}
          </Text>
        </View>
      </View>

      {/* File Path */}
      <View className="gap-2">
        <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
          File Path
        </Text>
        <View className="bg-card border border-border rounded-2xl p-4">
          <Text className="text-sm font-roobert text-foreground" selectable>
            {filePath}
          </Text>
        </View>
      </View>

      {/* File Content */}
      {fileContent && toolName !== 'delete-file' && (
        <View className="gap-2">
          <View className="flex-row items-center justify-between">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
              Content
            </Text>
            <Pressable
              onPress={handleCopy}
              className="flex-row items-center gap-1.5 bg-secondary active:bg-secondary/80 px-3 py-1.5 rounded-full"
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

          <View className="bg-card border border-border rounded-2xl p-4" style={{ maxHeight: 400 }}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text className="text-sm font-roobert text-foreground/80 leading-5" selectable>
                {fileContent}
              </Text>
            </ScrollView>
          </View>

          <View className="flex-row items-center gap-2">
            <View className="bg-card border border-border rounded-full px-3 py-1">
              <Text className="text-xs font-roobert-medium text-foreground/60">
                {fileContent.split('\n').length} lines
              </Text>
            </View>
            <View className="bg-card border border-border rounded-full px-3 py-1">
              <Text className="text-xs font-roobert-medium text-foreground/60">
                {fileContent.length} chars
              </Text>
            </View>
            {fileExtension && (
              <View className="bg-primary/10 border border-primary/20 rounded-full px-3 py-1">
                <Text className="text-xs font-roobert-medium text-primary">
                  .{fileExtension}
                </Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Status */}
      <View className="gap-2">
        <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
          Status
        </Text>
        <View className={`flex-row items-center gap-2 rounded-2xl p-4 border ${
          isError 
            ? 'bg-destructive/5 border-destructive/20' 
            : 'bg-primary/5 border-primary/20'
        }`}>
          <Icon 
            as={isError ? AlertCircle : CheckCircle2} 
            size={18} 
            className={isError ? 'text-destructive' : 'text-primary'} 
          />
          <Text className={`text-sm font-roobert-medium ${
            isError ? 'text-destructive' : 'text-primary'
          }`}>
            {isError ? 'Operation Failed' : 'Operation Successful'}
          </Text>
        </View>
        {result.output && typeof result.output === 'string' && (
          <View className="bg-card border border-border rounded-2xl p-4">
            <Text className="text-sm font-roobert text-foreground/80">
              {result.output}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

