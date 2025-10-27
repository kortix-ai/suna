import React from 'react';
import { View, ScrollView, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { BookOpen, CheckCircle2, AlertCircle, ExternalLink, Calendar, Users, FileText, Award } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractPaperSearchData } from './_utils';
import * as Haptics from 'expo-haptics';

export function PaperSearchToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { query, total_results, results, success } = extractPaperSearchData(toolData);

  const handleOpenUrl = (url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Linking.openURL(url);
  };

  const getSourceName = (url: string): string => {
    if (!url) return 'Source';
    try {
      const domain = url.toLowerCase();
      if (domain.includes('semanticscholar')) return 'Semantic Scholar';
      if (domain.includes('arxiv')) return 'arXiv';
      if (domain.includes('pubmed')) return 'PubMed';
      if (domain.includes('ieee')) return 'IEEE';
      if (domain.includes('acm')) return 'ACM';
      if (domain.includes('nature')) return 'Nature';
      if (domain.includes('springer')) return 'Springer';
      if (domain.includes('sciencedirect')) return 'ScienceDirect';
      
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.replace(/^www\./, '');
      return hostname.split('.')[0].charAt(0).toUpperCase() + hostname.split('.')[0].slice(1);
    } catch {
      return 'Source';
    }
  };

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-purple-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={BookOpen} size={40} className="text-purple-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Searching Papers
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
            <View className="bg-purple-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
              <Icon as={BookOpen} size={24} className="text-purple-500" />
            </View>
            <View className="flex-1">
              <Text className="text-xl font-roobert-semibold text-foreground">
                Paper Search
              </Text>
            </View>
          </View>

          <View className="py-8 items-center">
            <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
              <Icon as={BookOpen} size={40} className="text-muted-foreground" />
            </View>
            <Text className="text-lg font-roobert-semibold text-foreground mb-2">
              No Papers Found
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
          <View className="bg-purple-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={BookOpen} size={24} className="text-purple-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Research Papers
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              {total_results} {total_results === 1 ? 'Paper' : 'Papers'}
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
          {results.map((result, idx) => {
            const sourceName = getSourceName(result.url);
            const authorNames = result.authors?.slice(0, 3).map(a => a.name).join(', ');
            const hasMoreAuthors = (result.authors?.length || 0) > 3;

            return (
              <Pressable
                key={result.id || idx}
                onPress={() => handleOpenUrl(result.url)}
                className="bg-card border border-border rounded-2xl p-4 gap-3"
              >
                <View className="flex-row items-start justify-between gap-3">
                  <View className="flex-1 gap-2">
                    <View className="flex-row items-center gap-2 flex-wrap">
                      <View className="bg-muted/50 px-2 py-1 rounded">
                        <Text className="text-xs font-roobert-mono text-muted-foreground">
                          {sourceName}
                        </Text>
                      </View>
                      <Text className="text-xs text-muted-foreground">
                        #{idx + 1}
                      </Text>
                      {result.is_open_access && (
                        <View className="bg-emerald-500/10 px-2 py-1 rounded">
                          <Text className="text-xs font-roobert-medium text-emerald-600 dark:text-emerald-400">
                            Open Access
                          </Text>
                        </View>
                      )}
                    </View>

                    <Text className="text-base font-roobert-semibold text-foreground" numberOfLines={3}>
                      {result.title}
                    </Text>
                  </View>

                  <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
                </View>

                {result.abstract && (
                  <Text className="text-sm font-roobert text-foreground/70" numberOfLines={3}>
                    {result.abstract}
                  </Text>
                )}

                <View className="flex-row flex-wrap gap-2">
                  {result.year && (
                    <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                      <Icon as={Calendar} size={12} className="text-muted-foreground" />
                      <Text className="text-xs font-roobert text-muted-foreground">
                        {result.year}
                      </Text>
                    </View>
                  )}
                  
                  {authorNames && (
                    <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded flex-1">
                      <Icon as={Users} size={12} className="text-muted-foreground" />
                      <Text className="text-xs font-roobert text-muted-foreground flex-1" numberOfLines={1}>
                        {authorNames}{hasMoreAuthors ? '...' : ''}
                      </Text>
                    </View>
                  )}
                  
                  {result.citation_count !== undefined && result.citation_count > 0 && (
                    <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                      <Icon as={Award} size={12} className="text-muted-foreground" />
                      <Text className="text-xs font-roobert text-muted-foreground">
                        {result.citation_count}
                      </Text>
                    </View>
                  )}
                </View>

                {result.venue && (
                  <View className="flex-row items-center gap-1.5">
                    <Icon as={FileText} size={12} className="text-muted-foreground" />
                    <Text className="text-xs font-roobert text-muted-foreground flex-1" numberOfLines={1}>
                      {result.venue}
                    </Text>
                  </View>
                )}

                {result.fields_of_study && result.fields_of_study.length > 0 && (
                  <View className="flex-row flex-wrap gap-1.5">
                    {result.fields_of_study.slice(0, 3).map((field, fieldIdx) => (
                      <View key={fieldIdx} className="bg-blue-500/10 px-2 py-0.5 rounded">
                        <Text className="text-xs font-roobert text-blue-600 dark:text-blue-400">
                          {field}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}

