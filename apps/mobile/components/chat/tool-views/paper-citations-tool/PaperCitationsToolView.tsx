import React from 'react';
import { View, ScrollView, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Quote, CheckCircle2, AlertCircle, ExternalLink, Calendar, Users, Award } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractPaperCitationsData } from './_utils';
import * as Haptics from 'expo-haptics';

export function PaperCitationsToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { paper_title, total_citations, citations, success } = extractPaperCitationsData(toolData);

  const handleOpenUrl = (url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Linking.openURL(url);
  };

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-purple-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Quote} size={40} className="text-purple-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Fetching Citations
        </Text>
        {paper_title && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3">
            <Text className="text-sm font-roobert text-foreground/60 text-center" numberOfLines={2}>
              {paper_title}
            </Text>
          </View>
        )}
      </View>
    );
  }

  if (citations.length === 0) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
          <Icon as={Quote} size={40} className="text-muted-foreground" />
        </View>
        <Text className="text-lg font-roobert-semibold text-foreground mb-2">
          No Citations Found
        </Text>
        {paper_title && (
          <Text className="text-sm font-roobert text-muted-foreground text-center px-6">
            {paper_title}
          </Text>
        )}
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-purple-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Quote} size={24} className="text-purple-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Citations
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              {total_citations} {total_citations === 1 ? 'Citation' : 'Citations'}
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

        {paper_title && (
          <View className="bg-muted/30 rounded-xl p-4 border border-border">
            <Text className="text-xs font-roobert-medium text-muted-foreground mb-2">
              Paper
            </Text>
            <Text className="text-sm font-roobert-semibold text-foreground">
              {paper_title}
            </Text>
          </View>
        )}

        <View className="gap-3">
          {citations.map((citation, idx) => {
            const authorNames = citation.authors.slice(0, 2).join(', ');
            const hasMoreAuthors = citation.authors.length > 2;

            return (
              <Pressable
                key={citation.paper_id || idx}
                onPress={() => citation.url && handleOpenUrl(citation.url)}
                className="bg-card border border-border rounded-2xl p-4 gap-3"
              >
                <View className="flex-row items-start justify-between gap-3">
                  <View className="flex-1 gap-2">
                    <Text className="text-base font-roobert-semibold text-foreground" numberOfLines={3}>
                      {citation.title}
                    </Text>
                    
                    {authorNames && (
                      <View className="flex-row items-center gap-1.5">
                        <Icon as={Users} size={12} className="text-muted-foreground" />
                        <Text className="text-sm font-roobert text-muted-foreground flex-1" numberOfLines={1}>
                          {authorNames}{hasMoreAuthors ? ` +${citation.authors.length - 2}` : ''}
                        </Text>
                      </View>
                    )}

                    <View className="flex-row flex-wrap gap-2">
                      {citation.year && (
                        <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                          <Icon as={Calendar} size={12} className="text-muted-foreground" />
                          <Text className="text-xs font-roobert text-muted-foreground">
                            {citation.year}
                          </Text>
                        </View>
                      )}
                      
                      {citation.citation_count !== undefined && (
                        <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                          <Icon as={Award} size={12} className="text-muted-foreground" />
                          <Text className="text-xs font-roobert text-muted-foreground">
                            {citation.citation_count}
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>

                  {citation.url && (
                    <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}

