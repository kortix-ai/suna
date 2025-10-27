import React from 'react';
import { View, ScrollView, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { GraduationCap, CheckCircle2, AlertCircle, ExternalLink, Building, Award, BookOpen, Hash } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractAuthorSearchData } from './_utils';
import * as Haptics from 'expo-haptics';

export function AuthorSearchToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { query, total_results, results, success } = extractAuthorSearchData(toolData);

  const handleOpenUrl = (url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Linking.openURL(url);
  };

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-indigo-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={GraduationCap} size={40} className="text-indigo-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Searching Authors
        </Text>
        {query && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3">
            <Text className="text-sm font-roobert text-foreground/60 text-center" numberOfLines={2}>
              {query}
            </Text>
          </View>
        )}
      </View>
    );
  }

  if (results.length === 0) {
    return (
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="px-6 py-4 gap-6">
          <View className="flex-row items-center gap-3">
            <View className="bg-indigo-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
              <Icon as={GraduationCap} size={24} className="text-indigo-500" />
            </View>
            <View className="flex-1">
              <Text className="text-xl font-roobert-semibold text-foreground">
                Author Search
              </Text>
            </View>
          </View>

          <View className="py-8 items-center">
            <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
              <Icon as={GraduationCap} size={40} className="text-muted-foreground" />
            </View>
            <Text className="text-lg font-roobert-semibold text-foreground mb-2">
              No Authors Found
            </Text>
            {query && (
              <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3 w-full">
                <Text className="text-sm font-roobert-mono text-foreground/60 text-center">
                  {query}
                </Text>
              </View>
            )}
            <Text className="text-sm font-roobert text-muted-foreground text-center mt-3">
              Try refining your search criteria
            </Text>
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-indigo-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={GraduationCap} size={24} className="text-indigo-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Authors
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              {total_results} {total_results === 1 ? 'Author' : 'Authors'}
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
              {success ? 'Found' : 'Failed'}
            </Text>
          </View>
        </View>

        <View className="gap-3">
          {results.map((result, idx) => (
            <Pressable
              key={result.author_id || idx}
              onPress={() => handleOpenUrl(result.url)}
              className="bg-card border border-border rounded-2xl p-4 gap-3"
            >
              <View className="flex-row items-start justify-between gap-3">
                <View className="flex-1 gap-2">
                  <Text className="text-base font-roobert-semibold text-foreground">
                    {result.name}
                  </Text>

                  {result.affiliations && result.affiliations.length > 0 && (
                    <View className="flex-row items-center gap-1.5">
                      <Icon as={Building} size={12} className="text-muted-foreground" />
                      <Text className="text-sm font-roobert text-muted-foreground flex-1" numberOfLines={2}>
                        {result.affiliations.join(', ')}
                      </Text>
                    </View>
                  )}
                </View>

                <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
              </View>

              <View className="flex-row flex-wrap gap-2">
                <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                  <Icon as={BookOpen} size={12} className="text-muted-foreground" />
                  <Text className="text-xs font-roobert text-muted-foreground">
                    {result.paper_count} papers
                  </Text>
                </View>
                
                <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                  <Icon as={Award} size={12} className="text-muted-foreground" />
                  <Text className="text-xs font-roobert text-muted-foreground">
                    {result.citation_count} citations
                  </Text>
                </View>
                
                <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                  <Icon as={Hash} size={12} className="text-muted-foreground" />
                  <Text className="text-xs font-roobert text-muted-foreground">
                    h-index: {result.h_index}
                  </Text>
                </View>
              </View>

              {result.homepage && (
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation();
                    handleOpenUrl(result.homepage!);
                  }}
                  className="bg-blue-500/10 rounded-lg p-2 flex-row items-center justify-center gap-2"
                >
                  <Icon as={ExternalLink} size={14} className="text-blue-600 dark:text-blue-400" />
                  <Text className="text-xs font-roobert-medium text-blue-600 dark:text-blue-400">
                    Homepage
                  </Text>
                </Pressable>
              )}
            </Pressable>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

