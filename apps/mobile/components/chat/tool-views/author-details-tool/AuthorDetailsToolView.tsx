import React from 'react';
import { View, ScrollView, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { GraduationCap, CheckCircle2, AlertCircle, ExternalLink, Building, Award, BookOpen, Hash, User } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractAuthorDetailsData } from './_utils';
import * as Haptics from 'expo-haptics';

export function AuthorDetailsToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { author, success } = extractAuthorDetailsData(toolData);

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
          Fetching Author Details
        </Text>
      </View>
    );
  }

  if (!author) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
          <Icon as={GraduationCap} size={40} className="text-muted-foreground" />
        </View>
        <Text className="text-lg font-roobert-semibold text-foreground mb-2">
          No Author Found
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          Unable to retrieve author details
        </Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-indigo-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={User} size={24} className="text-indigo-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Author Details
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={2}>
              {author.name}
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
          onPress={() => handleOpenUrl(author.url)}
          className="bg-card border border-border rounded-2xl p-4 gap-4"
        >
          <View className="flex-row items-start justify-between">
            <View className="flex-1 gap-3">
              <Text className="text-lg font-roobert-semibold text-foreground">
                {author.name}
              </Text>

              {author.affiliations && author.affiliations.length > 0 && (
                <View className="flex-row items-start gap-2 bg-muted/20 p-3 rounded-xl">
                  <Icon as={Building} size={14} className="text-muted-foreground flex-shrink-0 mt-0.5" />
                  <Text className="text-sm font-roobert text-foreground flex-1">
                    {author.affiliations.join(', ')}
                  </Text>
                </View>
              )}

              <View className="flex-row flex-wrap gap-2">
                <View className="bg-muted/30 rounded-xl p-3 flex-1">
                  <View className="flex-row items-center gap-2 mb-1">
                    <Icon as={BookOpen} size={14} className="text-muted-foreground" />
                    <Text className="text-xs font-roobert-medium text-muted-foreground">Papers</Text>
                  </View>
                  <Text className="text-lg font-roobert-semibold text-foreground">
                    {author.paper_count}
                  </Text>
                </View>

                <View className="bg-muted/30 rounded-xl p-3 flex-1">
                  <View className="flex-row items-center gap-2 mb-1">
                    <Icon as={Award} size={14} className="text-muted-foreground" />
                    <Text className="text-xs font-roobert-medium text-muted-foreground">Citations</Text>
                  </View>
                  <Text className="text-lg font-roobert-semibold text-foreground">
                    {author.citation_count}
                  </Text>
                </View>

                <View className="bg-muted/30 rounded-xl p-3 flex-1">
                  <View className="flex-row items-center gap-2 mb-1">
                    <Icon as={Hash} size={14} className="text-muted-foreground" />
                    <Text className="text-xs font-roobert-medium text-muted-foreground">h-index</Text>
                  </View>
                  <Text className="text-lg font-roobert-semibold text-foreground">
                    {author.h_index}
                  </Text>
                </View>
              </View>

              {author.homepage && (
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation();
                    handleOpenUrl(author.homepage!);
                  }}
                  className="bg-blue-500/10 rounded-xl p-3 flex-row items-center justify-center gap-2"
                >
                  <Icon as={ExternalLink} size={16} className="text-blue-600 dark:text-blue-400" />
                  <Text className="text-sm font-roobert-medium text-blue-600 dark:text-blue-400">
                    Visit Homepage
                  </Text>
                </Pressable>
              )}

              {author.aliases && author.aliases.length > 0 && (
                <View className="bg-muted/20 p-3 rounded-xl gap-2">
                  <Text className="text-xs font-roobert-medium text-muted-foreground">Also known as:</Text>
                  <View className="flex-row flex-wrap gap-1.5">
                    {author.aliases.map((alias, idx) => (
                      <View key={idx} className="bg-muted/50 px-2 py-1 rounded">
                        <Text className="text-xs font-roobert text-foreground">
                          {alias}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </View>

            <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
          </View>
        </Pressable>
      </View>
    </ScrollView>
  );
}

