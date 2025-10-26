import React from 'react';
import { View, ScrollView, Linking, Pressable, Image as RNImage } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Users, CheckCircle2, AlertCircle, ExternalLink, MapPin, Briefcase, User } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractPeopleSearchData } from './_utils';
import * as Haptics from 'expo-haptics';

export function PeopleSearchToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { query, total_results, results, success } = extractPeopleSearchData(toolData);

  const handleOpenUrl = (url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Linking.openURL(url);
  };

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-purple-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Users} size={40} className="text-purple-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Searching People
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
              <Icon as={Users} size={24} className="text-purple-500" />
            </View>
            <View className="flex-1">
              <Text className="text-xl font-roobert-semibold text-foreground">
                People Search
              </Text>
            </View>
          </View>

          <View className="py-8 items-center">
            <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
              <Icon as={Users} size={40} className="text-muted-foreground" />
            </View>
            <Text className="text-lg font-roobert-semibold text-foreground mb-2">
              No People Found
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
            <Icon as={Users} size={24} className="text-purple-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              People Search
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              {total_results} {total_results === 1 ? 'Person' : 'People'}
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
              key={result.id || idx}
              onPress={() => handleOpenUrl(result.url)}
              className="bg-card border border-border rounded-2xl p-4 gap-3"
            >
              <View className="flex-row items-start gap-3">
                <View className="flex-shrink-0">
                  {result.person_picture_url ? (
                    <RNImage
                      source={{ uri: result.person_picture_url }}
                      style={{ width: 48, height: 48, borderRadius: 24 }}
                    />
                  ) : (
                    <View className="bg-muted rounded-full items-center justify-center" style={{ width: 48, height: 48 }}>
                      <Icon as={User} size={24} className="text-muted-foreground" />
                    </View>
                  )}
                </View>

                <View className="flex-1 gap-1">
                  <Text className="text-base font-roobert-semibold text-foreground">
                    {result.person_name}
                  </Text>
                  
                  {result.person_position && (
                    <View className="flex-row items-center gap-1.5">
                      <Icon as={Briefcase} size={12} className="text-muted-foreground" />
                      <Text className="text-sm font-roobert text-muted-foreground flex-1" numberOfLines={2}>
                        {result.person_position}
                      </Text>
                    </View>
                  )}
                  
                  {result.person_location && (
                    <View className="flex-row items-center gap-1.5">
                      <Icon as={MapPin} size={12} className="text-muted-foreground" />
                      <Text className="text-sm font-roobert text-muted-foreground">
                        {result.person_location}
                      </Text>
                    </View>
                  )}
                </View>

                <View className="flex-shrink-0">
                  <Icon as={ExternalLink} size={16} className="text-muted-foreground" />
                </View>
              </View>

              {result.description && (
                <Text className="text-sm font-roobert text-foreground/70" numberOfLines={3}>
                  {result.description}
                </Text>
              )}
            </Pressable>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

