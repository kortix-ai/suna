import React from 'react';
import { View, ScrollView, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { BookOpen, CheckCircle2, AlertCircle, ExternalLink, Calendar, Users, Award, FileText, Hash } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractPaperDetailsData } from './_utils';
import * as Haptics from 'expo-haptics';

export function PaperDetailsToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { paper, success } = extractPaperDetailsData(toolData);

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
          Fetching Paper Details
        </Text>
      </View>
    );
  }

  if (!paper) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
          <Icon as={BookOpen} size={40} className="text-muted-foreground" />
        </View>
        <Text className="text-lg font-roobert-semibold text-foreground mb-2">
          No Paper Found
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          Unable to retrieve paper details
        </Text>
      </View>
    );
  }

  const authorNames = paper.authors?.slice(0, 3).map(a => a.name).join(', ');
  const hasMoreAuthors = (paper.authors?.length || 0) > 3;

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-purple-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={BookOpen} size={24} className="text-purple-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Paper Details
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              Research Paper
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

        <Pressable
          onPress={() => handleOpenUrl(paper.url)}
          className="bg-card border border-border rounded-2xl p-4 gap-4"
        >
          <View className="gap-2">
            <View className="flex-row items-center justify-between">
              <Text className="text-lg font-roobert-semibold text-foreground flex-1 pr-2">
                {paper.title}
              </Text>
              <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
            </View>

            <View className="flex-row flex-wrap gap-2">
              {paper.year && (
                <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                  <Icon as={Calendar} size={12} className="text-muted-foreground" />
                  <Text className="text-xs font-roobert text-muted-foreground">
                    {paper.year}
                  </Text>
                </View>
              )}
              
              {paper.is_open_access && (
                <View className="bg-emerald-500/10 px-2 py-1 rounded">
                  <Text className="text-xs font-roobert-medium text-emerald-600 dark:text-emerald-400">
                    Open Access
                  </Text>
                </View>
              )}
              
              {paper.citation_count !== undefined && (
                <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                  <Icon as={Award} size={12} className="text-muted-foreground" />
                  <Text className="text-xs font-roobert text-muted-foreground">
                    {paper.citation_count} citations
                  </Text>
                </View>
              )}
            </View>
          </View>

          {authorNames && (
            <View className="flex-row items-center gap-2 bg-muted/20 p-3 rounded-xl">
              <Icon as={Users} size={14} className="text-muted-foreground" />
              <Text className="text-sm font-roobert text-foreground flex-1">
                {authorNames}{hasMoreAuthors ? ` +${paper.authors!.length - 3} more` : ''}
              </Text>
            </View>
          )}

          {paper.venue && (
            <View className="flex-row items-center gap-2 bg-muted/20 p-3 rounded-xl">
              <Icon as={FileText} size={14} className="text-muted-foreground" />
              <Text className="text-sm font-roobert text-foreground flex-1" numberOfLines={2}>
                {paper.venue}
              </Text>
            </View>
          )}

          {(paper.abstract || paper.tldr) && (
            <View className="gap-2">
              <Text className="text-sm font-roobert-medium text-foreground/70">
                {paper.tldr ? 'TL;DR' : 'Abstract'}
              </Text>
              <Text className="text-sm font-roobert text-foreground/80" numberOfLines={6}>
                {paper.tldr || paper.abstract}
              </Text>
            </View>
          )}

          {paper.fields_of_study && paper.fields_of_study.length > 0 && (
            <View className="flex-row flex-wrap gap-1.5">
              {paper.fields_of_study.slice(0, 5).map((field, idx) => (
                <View key={idx} className="bg-blue-500/10 px-2 py-1 rounded">
                  <Text className="text-xs font-roobert text-blue-600 dark:text-blue-400">
                    {field}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {paper.pdf_url && (
            <Pressable
              onPress={() => handleOpenUrl(paper.pdf_url!)}
              className="bg-primary/10 rounded-xl p-3 flex-row items-center justify-center gap-2"
            >
              <Icon as={FileText} size={16} className="text-primary" />
              <Text className="text-sm font-roobert-medium text-primary">
                View PDF
              </Text>
            </Pressable>
          )}
        </Pressable>
      </View>
    </ScrollView>
  );
}

