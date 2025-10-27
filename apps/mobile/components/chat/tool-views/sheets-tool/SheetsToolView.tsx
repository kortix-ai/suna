import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Table2, CheckCircle2, AlertCircle, FileSpreadsheet, Hash } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractSheetsData } from './_utils';

export function SheetsToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { filePath, fileName, action, headers, rows, success } = extractSheetsData(toolData);

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-emerald-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Table2} size={40} className="text-emerald-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Processing Sheet
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
          <View className="bg-emerald-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Table2} size={24} className="text-emerald-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              {action}
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              {fileName || 'Spreadsheet'}
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
              {success ? 'Success' : 'Failed'}
            </Text>
          </View>
        </View>

        {filePath && (
          <View className="bg-muted/30 rounded-xl p-3 border border-border">
            <View className="flex-row items-center gap-2 mb-1">
              <Icon as={FileSpreadsheet} size={14} className="text-muted-foreground" />
              <Text className="text-xs font-roobert-medium text-muted-foreground">File Path</Text>
            </View>
            <Text className="text-sm font-roobert-mono text-foreground" selectable numberOfLines={2}>
              {filePath}
            </Text>
          </View>
        )}

        {headers.length > 0 && rows.length > 0 && (
          <View className="gap-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Preview
              </Text>
              <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                <Icon as={Hash} size={12} className="text-muted-foreground" />
                <Text className="text-xs font-roobert text-muted-foreground">
                  {rows.length} rows
                </Text>
              </View>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={true} className="border border-border rounded-xl">
              <View>
                <View className="flex-row bg-muted/50 border-b border-border">
                  {headers.map((header, idx) => (
                    <View 
                      key={idx}
                      className="px-3 py-2 border-r border-border"
                      style={{ minWidth: 120 }}
                    >
                      <Text className="text-xs font-roobert-semibold text-foreground">
                        {header}
                      </Text>
                    </View>
                  ))}
                </View>
                
                {rows.slice(0, 10).map((row, rowIdx) => (
                  <View key={rowIdx} className="flex-row border-b border-border">
                    {row.map((cell, cellIdx) => (
                      <View 
                        key={cellIdx}
                        className="px-3 py-2 border-r border-border"
                        style={{ minWidth: 120 }}
                      >
                        <Text className="text-xs font-roobert text-foreground" numberOfLines={2}>
                          {String(cell ?? '')}
                        </Text>
                      </View>
                    ))}
                  </View>
                ))}
                
                {rows.length > 10 && (
                  <View className="bg-muted/30 p-3">
                    <Text className="text-xs font-roobert text-muted-foreground text-center">
                      +{rows.length - 10} more rows
                    </Text>
                  </View>
                )}
              </View>
            </ScrollView>
          </View>
        )}

        {!headers.length && !rows.length && filePath && (
          <View className="py-8 items-center">
            <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
              <Icon as={Table2} size={32} className="text-muted-foreground" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              Sheet {action}
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              No preview available
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

