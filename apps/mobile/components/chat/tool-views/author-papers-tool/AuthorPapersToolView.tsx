import React from 'react';
import { View, ScrollView, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { BookOpen, CheckCircle2, AlertCircle, ExternalLink, Calendar, Award, FileText } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractAuthorPapersData } from './_utils';
import * as Haptics from 'expo-haptics';

export function AuthorPapersToolView({ toolCall, toolResult, isStreaming = false }: ToolViewProps) {
  const { author_name, total_papers, papers, success } = extractAuthorPapersData({ toolCall, toolResult });

  const handleOpenUrl = (url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Linking.openURL(url);
  };

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-purple-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={BookOpen} size={40} className="text-purple-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Fetching Author Papers
        </Text>
        {author_name && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3">
            <Text className="text-sm font-roobert text-foreground/60 text-center">
              {author_name}
            </Text>
          </View>
        )}
      </View>
    );
  }

  if (papers.length === 0) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-background rounded-2xl items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
          <Icon as={BookOpen} size={40} className="text-foreground/30" />
        </View>
        <Text className="text-lg font-roobert-semibold text-foreground mb-2">
          No Papers Found
        </Text>
        {author_name && (
          <Text className="text-sm font-roobert text-muted-foreground text-center">
            {author_name}
          </Text>
        )}
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 gap-6">
        <View className="bg-card border border-border rounded-2xl p-4">
          <Text className="text-sm font-roobert-medium text-foreground/50 mb-1">
            Total Publications
          </Text>
          <Text className="text-2xl font-roobert-semibold text-foreground">
            {total_papers}
          </Text>
        </View>

        <View className="gap-3">
          <Text className="text-sm font-roobert-medium text-foreground/70">
            Publications ({papers.length})
          </Text>
          {papers.map((paper, idx) => (
            <Pressable
              key={paper.paper_id || idx}
              onPress={() => handleOpenUrl(paper.url)}
              className="bg-card border border-border rounded-2xl p-4 gap-3"
            >
              <View className="flex-row items-start justify-between gap-3">
                <View className="flex-1 gap-2">
                  <Text className="text-base font-roobert-semibold text-foreground" numberOfLines={3}>
                    {paper.title}
                  </Text>

                  <View className="flex-row flex-wrap gap-2">
                    {paper.year && (
                      <View className="flex-row items-center gap-1.5 bg-background border border-border px-3 py-1 rounded-full">
                        <Icon as={Calendar} size={12} className="text-foreground/60" />
                        <Text className="text-xs font-roobert text-foreground/60">
                          {paper.year}
                        </Text>
                      </View>
                    )}

                    {paper.citation_count !== undefined && (
                      <View className="flex-row items-center gap-1.5 bg-background border border-border px-3 py-1 rounded-full">
                        <Icon as={Award} size={12} className="text-foreground/60" />
                        <Text className="text-xs font-roobert text-foreground/60">
                          {paper.citation_count}
                        </Text>
                      </View>
                    )}
                  </View>

                  {paper.venue && (
                    <View className="flex-row items-center gap-1.5">
                      <Icon as={FileText} size={12} className="text-muted-foreground" />
                      <Text className="text-xs font-roobert text-muted-foreground flex-1" numberOfLines={1}>
                        {paper.venue}
                      </Text>
                    </View>
                  )}
                </View>

                <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
              </View>
            </Pressable>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

