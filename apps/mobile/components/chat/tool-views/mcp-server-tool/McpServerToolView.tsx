import React from 'react';
import { View, ScrollView, Linking, Pressable, Image as RNImage } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Server, CheckCircle2, AlertCircle, Shield, Sparkles, Tag, ExternalLink } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractMcpServerData, getPrimaryAuthScheme } from './_utils';
import * as Haptics from 'expo-haptics';

export function McpServerToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { query, servers, server, message, success } = extractMcpServerData(toolData);

  const handleOpenUrl = (url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Linking.openURL(url);
  };

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-purple-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Server} size={40} className="text-purple-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Searching MCP Servers
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

  if (servers.length === 0 && !server && !message) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
          <Icon as={Server} size={40} className="text-muted-foreground" />
        </View>
        <Text className="text-lg font-roobert-semibold text-foreground mb-2">
          No Servers Found
        </Text>
        {query && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3 w-full">
            <Text className="text-sm font-roobert-mono text-foreground/60 text-center">
              {query}
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
          <View className="bg-purple-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Server} size={24} className="text-purple-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              MCP Servers
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              {servers.length} {servers.length === 1 ? 'Server' : 'Servers'}
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

        {message && (
          <View className="bg-muted/50 rounded-xl p-4 border border-border">
            <Text className="text-sm font-roobert text-foreground">
              {message}
            </Text>
          </View>
        )}

        {server && (
          <View className="bg-card border border-border rounded-xl p-4 gap-3">
            <View className="flex-row items-start gap-3">
              {server.logo_url && (
                <RNImage
                  source={{ uri: server.logo_url }}
                  style={{ width: 48, height: 48, borderRadius: 12 }}
                  resizeMode="contain"
                />
              )}
              <View className="flex-1 gap-2">
                <View className="flex-row items-center gap-2">
                  <Text className="text-lg font-roobert-semibold text-foreground">
                    {server.name}
                  </Text>
                  {server.auth_schemes?.includes('OAUTH2') && (
                    <Icon as={Sparkles} size={16} className="text-emerald-500" />
                  )}
                </View>
                <Text className="text-xs font-roobert-mono text-muted-foreground">
                  {server.toolkit_slug}
                </Text>
              </View>
            </View>

            {server.description && (
              <Text className="text-sm font-roobert text-foreground/70">
                {server.description}
              </Text>
            )}

            <View className="flex-row items-center gap-2">
              <Icon as={Shield} size={14} className="text-muted-foreground" />
              <Text className="text-xs font-roobert text-muted-foreground">
                {getPrimaryAuthScheme(server.auth_schemes)}
              </Text>
            </View>

            {server.tags && server.tags.length > 0 && (
              <View className="flex-row flex-wrap gap-1.5">
                {server.tags.slice(0, 4).map((tag, idx) => (
                  <View key={idx} className="bg-muted/50 px-2 py-1 rounded">
                    <Text className="text-xs font-roobert text-foreground">
                      {tag}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {servers.length > 0 && (
          <View className="gap-3">
            {servers.map((srv, idx) => {
              const hasOAuth = srv.auth_schemes?.includes('OAUTH2');
              
              return (
                <View key={idx} className="bg-card border border-border rounded-xl p-4 gap-3">
                  <View className="flex-row items-start gap-3">
                    {srv.logo_url ? (
                      <RNImage
                        source={{ uri: srv.logo_url }}
                        style={{ width: 40, height: 40, borderRadius: 8 }}
                        resizeMode="contain"
                      />
                    ) : (
                      <View className="bg-muted rounded-lg items-center justify-center" style={{ width: 40, height: 40 }}>
                        <Icon as={Server} size={20} className="text-muted-foreground" />
                      </View>
                    )}

                    <View className="flex-1 gap-2">
                      <View className="flex-row items-center gap-2">
                        <Text className="text-base font-roobert-semibold text-foreground flex-1" numberOfLines={1}>
                          {srv.name}
                        </Text>
                        {hasOAuth && (
                          <Icon as={Sparkles} size={14} className="text-emerald-500" />
                        )}
                      </View>
                      
                      <Text className="text-xs font-roobert-mono text-muted-foreground" numberOfLines={1}>
                        {srv.toolkit_slug}
                      </Text>
                      
                      {srv.description && (
                        <Text className="text-sm font-roobert text-foreground/70" numberOfLines={2}>
                          {srv.description}
                        </Text>
                      )}

                      <View className="flex-row items-center gap-2">
                        <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                          <Icon as={Shield} size={10} className="text-muted-foreground" />
                          <Text className="text-xs font-roobert text-muted-foreground">
                            {getPrimaryAuthScheme(srv.auth_schemes)}
                          </Text>
                        </View>
                      </View>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

