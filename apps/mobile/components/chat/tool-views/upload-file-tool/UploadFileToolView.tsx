import React, { useState } from 'react';
import { View, ScrollView, TouchableOpacity, ActivityIndicator, Linking } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { RefreshCw, ExternalLink } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractUploadFileData } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
import { getToolMetadata } from '../tool-metadata';
import { API_URL, getAuthHeaders } from '@/api/config';
import { useToast } from '@/components/ui/toast-provider';
import { log } from '@/lib/logger';

function formatTimestamp(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString();
  } catch (e) {
    return 'Invalid date';
  }
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return '';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function UploadFileToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { filePath, fileName, fileSize, message, success, fileId, secureUrl, expiresAt } = extractUploadFileData({ toolCall, toolResult });
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regeneratedUrl, setRegeneratedUrl] = useState<string | null>(null);
  const [regeneratedExpiry, setRegeneratedExpiry] = useState<string | null>(null);
  const toast = useToast();

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

  const extractStoragePathFromUrl = (url: string): { storage_path: string; bucket_name: string } | null => {
    try {
      const match = url.match(/\/storage\/v1\/object\/sign\/([\w-]+)\/(.+?)\?/);
      if (match) {
        return {
          bucket_name: match[1],
          storage_path: decodeURIComponent(match[2]),
        };
      }
    } catch (e) {
      log.error('Failed to extract storage path from URL:', e);
    }
    return null;
  };

  const regenerateLink = async () => {
    try {
      setIsRegenerating(true);
      
      const headers = await getAuthHeaders();
      const body: any = {};
      
      if (fileId) {
        body.file_upload_id = fileId;
      } else if (secureUrl) {
        const pathInfo = extractStoragePathFromUrl(secureUrl);
        if (pathInfo) {
          body.storage_path = pathInfo.storage_path;
          body.bucket_name = pathInfo.bucket_name;
        } else {
          toast.error('Could not extract file information from URL');
          return;
        }
      } else {
        toast.error('No file information available');
        return;
      }
      
      const response = await fetch(`${API_URL}/file-uploads/regenerate-link`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error('Failed to regenerate link');
      }

      const data = await response.json();
      setRegeneratedUrl(data.signed_url);
      setRegeneratedExpiry(data.expires_at);
      toast.success('Link regenerated!');
    } catch (error) {
      toast.error('Failed to regenerate link');
      log.error('Error regenerating link:', error);
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleOpenUrl = async () => {
    const url = regeneratedUrl || secureUrl;
    if (url) {
      await Linking.openURL(url);
    }
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
          rightContent: <StatusBadge variant="streaming" label="Uploading" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Uploading File"
            filePath={fileName || undefined}
            showProgress={false}
          />
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
        rightContent: (
          <StatusBadge
            variant={actualIsSuccess ? 'success' : 'error'}
            label={actualIsSuccess ? 'Uploaded' : 'Failed'}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {filePath && (
            <Text className="text-xs text-muted-foreground flex-1 font-roobert-mono" numberOfLines={1}>
              {filePath}
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
          {filePath && (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                File Path
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4">
                <Text className="text-sm font-roobert-mono text-foreground" selectable>
                  {filePath}
                </Text>
              </View>
            </View>
          )}

          {fileSize && (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                File Size
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4">
                <Text className="text-lg font-roobert-semibold text-foreground">
                  {formatFileSize(fileSize)}
                </Text>
              </View>
            </View>
          )}

          {message && (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                Message
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4">
                <Text className="text-sm font-roobert text-foreground" selectable>
                  {message}
                </Text>
              </View>
            </View>
          )}

          {(secureUrl || regeneratedUrl) && (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                Secure Access URL
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4 gap-3">
                <Text className="text-xs font-roobert-mono text-foreground" selectable>
                  {regeneratedUrl || secureUrl}
                </Text>
                {(regeneratedExpiry || expiresAt) && (
                  <Text className="text-xs text-muted-foreground">
                    ⏰ Expires: {regeneratedExpiry || expiresAt}
                  </Text>
                )}
                <View className="flex-row gap-2">
                  <TouchableOpacity
                    onPress={handleOpenUrl}
                    className="flex-1 bg-primary rounded-xl p-3 flex-row items-center justify-center gap-2"
                  >
                    <Icon as={ExternalLink} className="text-primary-foreground" size={16} />
                    <Text className="text-sm font-roobert-medium text-primary-foreground">
                      Open File
                    </Text>
                  </TouchableOpacity>
                  {(fileId || secureUrl) && (
                    <TouchableOpacity
                      onPress={regenerateLink}
                      disabled={isRegenerating}
                      className="flex-1 bg-secondary rounded-xl p-3 flex-row items-center justify-center gap-2"
                    >
                      {isRegenerating ? (
                        <ActivityIndicator size="small" />
                      ) : (
                        <Icon as={RefreshCw} className="text-secondary-foreground" size={16} />
                      )}
                      <Text className="text-sm font-roobert-medium text-secondary-foreground">
                        {isRegenerating ? 'Regenerating...' : 'Regenerate'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
