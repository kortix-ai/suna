import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Database, CheckCircle2, AlertCircle, FileText, Folder, File } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractKbData } from './_utils';

export function KbToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const data = extractKbData(toolData);
  
  const toolName = toolData?.toolName || '';
  const isInit = toolName.includes('init');
  const isSearch = toolName.includes('search');
  const isList = toolName.includes('ls') || toolName.includes('list');
  const isSync = toolName.includes('sync');

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-blue-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Database} size={40} className="text-blue-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          {isInit ? 'Initializing KB' : isSearch ? 'Searching KB' : isSync ? 'Syncing KB' : 'Processing KB'}
        </Text>
      </View>
    );
  }

  const totalItems = (data.files?.length || 0) + (data.folders?.length || 0) + (data.items?.length || 0);

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-blue-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Database} size={24} className="text-blue-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Knowledge Base
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              {isInit ? 'Initialized' : isSearch ? 'Search Results' : isList ? 'Contents' : 'KB'}
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

        {data.message && (
          <View className="bg-muted/50 rounded-xl p-4 border border-border">
            <Text className="text-sm font-roobert text-foreground">
              {data.message}
            </Text>
          </View>
        )}

        {data.path && (
          <View className="bg-card border border-border rounded-xl p-3">
            <Text className="text-xs font-roobert-medium text-muted-foreground mb-1">
              Path
            </Text>
            <Text className="text-sm font-roobert-mono text-foreground" selectable>
              {data.path}
            </Text>
          </View>
        )}

        {totalItems > 0 && (
          <View className="gap-3">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Items ({totalItems})
            </Text>
            
            {data.folders && data.folders.length > 0 && (
              <View className="gap-2">
                {data.folders.map((folder: any, idx: number) => (
                  <View key={idx} className="bg-card border border-border rounded-xl p-3 flex-row items-center gap-3">
                    <View className="bg-blue-500/10 rounded-lg p-2">
                      <Icon as={Folder} size={16} className="text-blue-500" />
                    </View>
                    <Text className="text-sm font-roobert text-foreground flex-1" numberOfLines={1}>
                      {folder.name || folder}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {data.files && data.files.length > 0 && (
              <View className="gap-2">
                {data.files.map((file: any, idx: number) => (
                  <View key={idx} className="bg-card border border-border rounded-xl p-3 flex-row items-center gap-3">
                    <View className="bg-emerald-500/10 rounded-lg p-2">
                      <Icon as={FileText} size={16} className="text-emerald-500" />
                    </View>
                    <Text className="text-sm font-roobert text-foreground flex-1" numberOfLines={2}>
                      {file.name || file.path || file}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {data.items && data.items.length > 0 && (
              <View className="gap-2">
                {data.items.map((item: any, idx: number) => (
                  <View key={idx} className="bg-card border border-border rounded-xl p-3 flex-row items-center gap-3">
                    <View className="bg-muted/50 rounded-lg p-2">
                      <Icon as={File} size={16} className="text-muted-foreground" />
                    </View>
                    <Text className="text-sm font-roobert text-foreground flex-1" numberOfLines={2}>
                      {item.name || item.path || item}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

