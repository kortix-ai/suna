import React from 'react';
import { View, ScrollView, Linking, Pressable, Image as RNImage } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Server, Shield, Sparkles } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractMcpServerData, getPrimaryAuthScheme } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
import { getToolMetadata } from '../tool-metadata';
import * as Haptics from 'expo-haptics';

// Utility functions
function formatTimestamp(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString();
  } catch (e) {
    return 'Invalid date';
  }
}

export function McpServerToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { query, servers, server, message, success } = extractMcpServerData({ toolCall, toolResult });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

  const handleOpenUrl = (url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Linking.openURL(url);
  };

  if (isStreaming) {
    return (
      <ToolViewCard
        header={{
          icon: toolMetadata.icon,
          iconColor: toolMetadata.iconColor,
          iconBgColor: toolMetadata.iconBgColor,
          subtitle: toolMetadata.subtitle.toUpperCase(),
          title: toolMetadata.title,
          isSuccess: actualIsSuccess,
          isStreaming: true,
          rightContent: <StatusBadge variant="streaming" label="Searching" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Searching MCP Servers"
            filePath={query || undefined}
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (servers.length === 0 && !server && !message) {
    return (
      <ToolViewCard
        header={{
          icon: toolMetadata.icon,
          iconColor: toolMetadata.iconColor,
          iconBgColor: toolMetadata.iconBgColor,
          subtitle: toolMetadata.subtitle.toUpperCase(),
          title: toolMetadata.title,
          isSuccess: false,
          isStreaming: false,
          rightContent: <StatusBadge variant="error" label="Not Found" />,
        }}
      >
        <View className="flex-1 w-full items-center justify-center py-12 px-6">
          <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
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
      </ToolViewCard>
    );
  }

  return (
    <ToolViewCard
      header={{
        icon: toolMetadata.icon,
        iconColor: toolMetadata.iconColor,
        iconBgColor: toolMetadata.iconBgColor,
        subtitle: toolMetadata.subtitle.toUpperCase(),
        title: toolMetadata.title,
        isSuccess: actualIsSuccess,
        isStreaming: false,
        showStatus: true,
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {query && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
              {query}
            </Text>
          )}
          {(toolTimestamp || assistantTimestamp) && (
            <Text className="text-xs text-muted-foreground ml-2">
              {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
            </Text>
          )}
        </View>
      }
    >
      <ScrollView className="flex-1 w-full" showsVerticalScrollIndicator={false}>
        <View className="px-4 py-4 gap-6">
          {message && (
            <View className="bg-card border border-border rounded-2xl p-4">
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
                      <Icon as={Sparkles} size={16} className="text-primary" />
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
                <Icon as={Shield} size={14} className="text-foreground/60" />
                <Text className="text-xs font-roobert text-foreground/60">
                  {getPrimaryAuthScheme(server.auth_schemes)}
                </Text>
              </View>

              {server.tags && server.tags.length > 0 && (
                <View className="flex-row flex-wrap gap-1.5">
                  {server.tags.slice(0, 4).map((tag, idx) => (
                    <View key={idx} className="bg-muted/30 border border-border px-3 py-1 rounded-full">
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
                        <View className="bg-muted/30 border border-border rounded-lg items-center justify-center" style={{ width: 40, height: 40 }}>
                          <Icon as={Server} size={20} className="text-foreground/60" />
                        </View>
                      )}

                      <View className="flex-1 gap-2">
                        <View className="flex-row items-center gap-2">
                          <Text className="text-base font-roobert-semibold text-foreground flex-1" numberOfLines={1}>
                            {srv.name}
                          </Text>
                          {hasOAuth && (
                            <Icon as={Sparkles} size={14} className="text-primary" />
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
                          <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-3 py-1 rounded-full">
                            <Icon as={Shield} size={10} className="text-foreground/60" />
                            <Text className="text-xs font-roobert text-foreground/60">
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
    </ToolViewCard>
  );
}
