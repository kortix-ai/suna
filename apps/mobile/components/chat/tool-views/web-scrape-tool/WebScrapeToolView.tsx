import React, { useState } from 'react';
import { View, ScrollView, ActivityIndicator, Image as RNImage, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Globe, CheckCircle2, AlertCircle, FileText, Copy, Check, Calendar, Zap } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractWebScrapeData, formatFileInfo, formatDomain, getFavicon } from './_utils';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

export function WebScrapeToolView({ toolData, isStreaming }: ToolViewProps) {
  const { url, files, message, urlCount, success } = extractWebScrapeData(toolData);
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  
  const domain = url ? formatDomain(url) : 'Unknown';
  const favicon = url ? getFavicon(url) : null;

  const copyFilePath = async (filePath: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await Clipboard.setStringAsync(filePath);
    setCopiedFile(filePath);
    setTimeout(() => setCopiedFile(null), 2000);
  };

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-primary/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <ActivityIndicator size="large" color="#0066FF" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Extracting Content
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          Analyzing and processing
        </Text>
        {url && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3 w-full">
            <Text className="text-xs font-roobert-medium text-foreground/60 text-center" numberOfLines={1}>
              {domain}
            </Text>
          </View>
        )}
      </View>
    );
  }

  if (!url) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Globe} size={40} className="text-muted-foreground" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          No URL Detected
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          Unable to extract a valid URL
        </Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Globe} size={24} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Web Scrape
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              {domain}
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

        <View className="gap-3">
          <View className="flex-row items-center gap-2">
            <Icon as={Globe} size={16} className="text-foreground/50" />
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Source URL
            </Text>
          </View>
          
          <View className="bg-card border border-border rounded-2xl p-4">
            <View className="flex-row items-center gap-3">
              {favicon && (
                <RNImage
                  source={{ uri: favicon }}
                  style={{ width: 24, height: 24, borderRadius: 6 }}
                />
              )}
              <View className="flex-1">
                <Text className="text-sm font-roobert-medium text-foreground" numberOfLines={2}>
                  {url}
                </Text>
                <Text className="text-xs font-roobert text-muted-foreground mt-1">
                  {domain}
                </Text>
              </View>
            </View>
          </View>
        </View>

        <View className="gap-3">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <Icon as={Zap} size={16} className="text-foreground/50" />
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Generated Files
              </Text>
            </View>
            <View className="bg-muted/30 rounded-lg px-2 py-1">
              <Text className="text-xs font-roobert-medium text-foreground/60">
                {files.length} file{files.length !== 1 ? 's' : ''}
              </Text>
            </View>
          </View>

          {files.length > 0 ? (
            <View className="gap-3">
              {files.map((filePath, idx) => {
                const fileInfo = formatFileInfo(filePath);
                const isCopied = copiedFile === filePath;

                return (
                  <View
                    key={idx}
                    className="bg-card border border-border rounded-2xl p-4"
                  >
                    <View className="flex-row items-start gap-3">
                      <View className="bg-primary/10 rounded-xl items-center justify-center" style={{ width: 40, height: 40 }}>
                        <Icon as={FileText} size={20} className="text-primary" />
                      </View>

                      <View className="flex-1 gap-2">
                        <View className="flex-row items-center gap-2 flex-wrap">
                          <View className="bg-muted/30 rounded-lg px-2 py-0.5">
                            <Text className="text-xs font-roobert-medium text-foreground/60">
                              JSON
                            </Text>
                          </View>
                          {fileInfo.timestamp && (
                            <View className="bg-muted/30 rounded-lg px-2 py-0.5 flex-row items-center gap-1">
                              <Icon as={Calendar} size={10} className="text-foreground/60" />
                              <Text className="text-xs font-roobert text-foreground/60">
                                {fileInfo.timestamp.replace('_', ' ')}
                              </Text>
                            </View>
                          )}
                        </View>

                        <Text className="text-sm font-roobert-medium text-foreground">
                          {fileInfo.fileName}
                        </Text>
                        <Text className="text-xs font-roobert text-muted-foreground" numberOfLines={2}>
                          {fileInfo.fullPath}
                        </Text>
                      </View>

                      <Pressable 
                        onPress={() => copyFilePath(filePath)}
                        className="bg-muted/30 rounded-lg p-1.5"
                      >
                        <Icon 
                          as={isCopied ? Check : Copy} 
                          size={14} 
                          className={isCopied ? 'text-primary' : 'text-foreground/60'} 
                        />
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>
          ) : (
            <View className="items-center justify-center py-8 bg-muted/10 rounded-2xl">
              <Icon as={FileText} size={32} className="text-muted-foreground opacity-50 mb-2" />
              <Text className="text-sm font-roobert text-muted-foreground">
                No files generated
              </Text>
            </View>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

