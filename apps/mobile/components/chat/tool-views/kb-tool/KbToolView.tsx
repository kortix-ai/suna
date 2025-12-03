import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Database, CheckCircle2, AlertCircle, FileText, Folder, File } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractKbData } from './_utils';

export function KbToolView({ toolCall, toolResult, isStreaming = false }: ToolViewProps) {
  const data = extractKbData({ toolCall, toolResult });

  const toolName = toolCall?.function_name || '';
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
    <View className="px-6 gap-6">
      {data.message && (
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            Message
          </Text>
          <View className="bg-card border border-border rounded-2xl p-4">
            <Text className="text-sm font-roobert text-foreground" selectable>
              {data.message}
            </Text>
          </View>
        </View>
      )}

      {data.path && (
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            Path
          </Text>
          <View className="bg-card border border-border rounded-2xl p-4">
            <Text className="text-sm font-roobert text-foreground" selectable>
              {data.path}
            </Text>
          </View>
        </View>
      )}

      {totalItems > 0 && (
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            Contents ({totalItems})
          </Text>

          {data.folders && data.folders.length > 0 && (
            <View className="gap-2">
              {data.folders.map((folder: any, idx: number) => (
                <View key={idx} className="bg-card border border-border rounded-2xl p-4 flex-row items-center gap-3">
                  <Icon as={Folder} size={18} className="text-primary" />
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
                <View key={idx} className="bg-card border border-border rounded-2xl p-4 flex-row items-center gap-3">
                  <Icon as={FileText} size={18} className="text-primary" />
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
                <View key={idx} className="bg-card border border-border rounded-2xl p-4 flex-row items-center gap-3">
                  <Icon as={File} size={18} className="text-primary" />
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
  );
}

