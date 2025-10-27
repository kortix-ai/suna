import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { FileText, CheckCircle2, AlertCircle, Calendar, Hash } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDocsData, getActionTitle, stripHtmlTags } from './_utils';

export function DocsToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const data = extractDocsData(toolData);
  
  const toolName = toolData?.toolName || 'docs';
  const actionTitle = getActionTitle(toolName);

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-blue-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={FileText} size={40} className="text-blue-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Processing Document
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          {actionTitle}...
        </Text>
      </View>
    );
  }

  if (data.error) {
    return (
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="px-6 py-4 gap-6">
          <View className="flex-row items-center gap-3">
            <View className="bg-red-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
              <Icon as={AlertCircle} size={24} className="text-red-500" />
            </View>
            <View className="flex-1">
              <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
                {actionTitle}
              </Text>
              <Text className="text-xl font-roobert-semibold text-foreground">
                Error
              </Text>
            </View>
          </View>

          <View className="bg-red-500/10 rounded-xl p-4 border border-red-500/20">
            <Text className="text-sm font-roobert text-red-600 dark:text-red-400">
              {data.error}
            </Text>
          </View>
        </View>
      </ScrollView>
    );
  }

  const document = data.document;
  const documents = data.documents;

  if (documents && documents.length > 0) {
    return (
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="px-6 py-4 gap-6">
          <View className="flex-row items-center gap-3">
            <View className="bg-blue-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
              <Icon as={FileText} size={24} className="text-blue-500" />
            </View>
            <View className="flex-1">
              <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
                Documents
              </Text>
              <Text className="text-xl font-roobert-semibold text-foreground">
                {documents.length} {documents.length === 1 ? 'Document' : 'Documents'}
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10">
              <Icon as={CheckCircle2} size={12} className="text-primary" />
              <Text className="text-xs font-roobert-medium text-primary">Success</Text>
            </View>
          </View>

          <View className="gap-3">
            {documents.map((doc, idx) => (
              <View key={idx} className="bg-card border border-border rounded-xl p-4">
                <Text className="text-base font-roobert-semibold text-foreground mb-2">
                  {doc.title}
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  <View className="bg-muted/50 px-2 py-1 rounded-lg">
                    <Text className="text-xs font-roobert-mono text-muted-foreground uppercase">
                      {doc.format}
                    </Text>
                  </View>
                  {doc.created_at && (
                    <View className="bg-muted/50 px-2 py-1 rounded-lg flex-row items-center gap-1">
                      <Icon as={Calendar} size={10} className="text-muted-foreground" />
                      <Text className="text-xs font-roobert text-muted-foreground">
                        {new Date(doc.created_at).toLocaleDateString()}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    );
  }

  if (document) {
    const content = data.content || document.content || '';
    const displayContent = stripHtmlTags(content);
    const contentLines = displayContent.split('\n').filter(line => line.trim());

    return (
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="px-6 py-4 gap-6">
          <View className="flex-row items-center gap-3">
            <View className="bg-blue-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
              <Icon as={FileText} size={24} className="text-blue-500" />
            </View>
            <View className="flex-1">
              <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={2}>
                {document.title}
              </Text>
            </View>
            <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${
              data.success ? 'bg-primary/10' : 'bg-destructive/10'
            }`}>
              <Icon 
                as={data.success ? CheckCircle2 : AlertCircle} 
                size={12} 
                className={data.success ? 'text-primary' : 'text-destructive'} 
              />
              <Text className={`text-xs font-roobert-medium ${
                data.success ? 'text-primary' : 'text-destructive'
              }`}>
                {data.success ? 'Success' : 'Failed'}
              </Text>
            </View>
          </View>

          {contentLines.length > 0 && (
            <View className="gap-2">
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Content
              </Text>
              <View className="bg-muted/10 dark:bg-muted/80 rounded-xl p-4 border border-border">
                {contentLines.map((line, idx) => (
                  <Text 
                    key={idx}
                    className="text-sm font-roobert text-foreground leading-6 mb-2"
                    selectable
                  >
                    {line}
                  </Text>
                ))}
              </View>
            </View>
          )}

          {document.metadata?.tags && document.metadata.tags.length > 0 && (
            <View className="gap-2">
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Tags
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {document.metadata.tags.map((tag, idx) => (
                  <View key={idx} className="bg-primary/10 px-3 py-1.5 rounded-full">
                    <Text className="text-xs font-roobert-medium text-primary">
                      {tag}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    );
  }

  if (data.message) {
    return (
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="px-6 py-4 gap-6">
          <View className="flex-row items-center gap-3">
            <View className="bg-blue-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
              <Icon as={FileText} size={24} className="text-blue-500" />
            </View>
            <View className="flex-1">
              <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
                {actionTitle}
              </Text>
              <Text className="text-xl font-roobert-semibold text-foreground">
                Success
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10">
              <Icon as={CheckCircle2} size={12} className="text-primary" />
              <Text className="text-xs font-roobert-medium text-primary">Success</Text>
            </View>
          </View>

          <View className="bg-primary/10 rounded-xl p-4 border border-primary/20">
            <Text className="text-sm font-roobert text-foreground">
              {data.message}
            </Text>
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <View className="flex-1 items-center justify-center py-12 px-6">
      <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
        <Icon as={FileText} size={40} className="text-muted-foreground" />
      </View>
      <Text className="text-xl font-roobert-semibold text-foreground mb-2">
        No Document Data
      </Text>
      <Text className="text-sm font-roobert text-muted-foreground text-center">
        No document information available
      </Text>
    </View>
  );
}

