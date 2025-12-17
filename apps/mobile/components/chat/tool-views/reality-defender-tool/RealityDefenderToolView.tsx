import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Shield, CheckCircle2, AlertTriangle, ImageIcon, Music, Video, File, HelpCircle, Info } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractRealityDefenderData } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
import { getToolMetadata } from '../tool-metadata';

function formatTimestamp(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString();
  } catch (e) {
    return 'Invalid date';
  }
}

export function RealityDefenderToolView({
  toolCall,
  toolResult,
  isSuccess = true,
  isStreaming,
  assistantTimestamp,
  toolTimestamp,
}: ToolViewProps) {
  const {
    filePath,
    mediaType,
    isDeepfake,
    confidence,
    verdict,
    indicators,
    analysisId,
    success,
  } = extractRealityDefenderData(toolCall, toolResult, isSuccess);

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success && isSuccess);
  const isLoading = isStreaming && !filePath;

  const getMediaIcon = () => {
    switch (mediaType) {
      case 'image':
        return ImageIcon;
      case 'audio':
        return Music;
      case 'video':
        return Video;
      default:
        return File;
    }
  };

  const getMediaTypeLabel = () => {
    switch (mediaType) {
      case 'image':
        return 'Image';
      case 'audio':
        return 'Audio';
      case 'video':
        return 'Video';
      default:
        return 'Media';
    }
  };

  const getVerdictInfo = () => {
    if (verdict === 'likely_manipulated' || isDeepfake) {
      return {
        label: 'Likely Manipulated',
        shortLabel: 'Manipulated',
        icon: AlertTriangle,
        variant: 'error' as const,
        color: 'text-red-600 dark:text-red-400',
      };
    } else if (verdict === 'likely_authentic') {
      return {
        label: 'Likely Authentic',
        shortLabel: 'Authentic',
        icon: CheckCircle2,
        variant: 'success' as const,
        color: 'text-emerald-600 dark:text-emerald-400',
      };
    } else {
      return {
        label: 'Uncertain',
        shortLabel: 'Uncertain',
        icon: HelpCircle,
        variant: 'warning' as const,
        color: 'text-amber-600 dark:text-amber-400',
      };
    }
  };

  const verdictInfo = getVerdictInfo();
  const MediaIcon = getMediaIcon();
  const VerdictIcon = verdictInfo.icon;

  if (isLoading) {
    return (
      <ToolViewCard
        header={{
          icon: Shield,
          iconColor: 'text-purple-600 dark:text-purple-400',
          iconBgColor: 'bg-purple-100 dark:bg-purple-900/30',
          subtitle: 'DEEPFAKE DETECTION',
          title: toolMetadata.title,
          isSuccess: actualIsSuccess,
          isStreaming: true,
          rightContent: <StatusBadge variant="streaming" label="Analyzing" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={Shield}
            iconColor="text-purple-600 dark:text-purple-400"
            bgColor="bg-purple-100 dark:bg-purple-900/30"
            title="Analyzing media file"
            filePath=""
            showProgress={true}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (!actualIsSuccess || !filePath) {
    return (
      <ToolViewCard
        header={{
          icon: Shield,
          iconColor: 'text-purple-600 dark:text-purple-400',
          iconBgColor: 'bg-purple-100 dark:bg-purple-900/30',
          subtitle: 'DEEPFAKE DETECTION',
          title: toolMetadata.title,
          isSuccess: actualIsSuccess,
          isStreaming: false,
          rightContent: (
            <StatusBadge
              variant={actualIsSuccess ? 'success' : 'error'}
              label={actualIsSuccess ? 'Completed' : 'Failed'}
            />
          ),
        }}
      >
        <View className="flex-1 items-center justify-center p-6">
          <View className="w-16 h-16 rounded-full items-center justify-center bg-muted mb-4">
            <Shield className="w-8 h-8 text-muted-foreground" />
          </View>
          <Text className="text-lg font-semibold mb-2 text-foreground text-center">
            {actualIsSuccess ? 'No Analysis Results' : 'Analysis Failed'}
          </Text>
          {filePath && (
            <View className="bg-muted border border-border rounded-lg p-3 w-full mb-4">
              <Text className="text-sm font-mono text-muted-foreground break-all text-center">
                {filePath}
              </Text>
            </View>
          )}
          <Text className="text-sm text-muted-foreground text-center">
            {actualIsSuccess
              ? 'No detection results available for this file'
              : 'Failed to analyze the media file. Please check the file format and try again.'}
          </Text>
        </View>
      </ToolViewCard>
    );
  }

  return (
    <ToolViewCard
      header={{
        icon: Shield,
        iconColor: 'text-purple-600 dark:text-purple-400',
        iconBgColor: 'bg-purple-100 dark:bg-purple-900/30',
        subtitle: 'DEEPFAKE DETECTION',
        title: toolMetadata.title,
        isSuccess: actualIsSuccess,
        isStreaming: false,
        rightContent: (
          <StatusBadge
            variant="success"
            label="Complete"
          />
        ),
      }}
      footer={
        <View className="px-4 py-2 border-t border-border flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <StatusBadge
              variant={verdictInfo.variant}
              label={verdictInfo.shortLabel}
            />
          </View>
          <Text className="text-xs text-muted-foreground">
            {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
          </Text>
        </View>
      }
    >
      <ScrollView className="flex-1" contentContainerClassName="p-4">
        {/* File Info */}
        <View className="mb-6">
          <View className="flex-row items-center gap-3 mb-2">
            <View className="p-2 rounded-lg bg-muted">
              <MediaIcon className="w-5 h-5 text-foreground" />
            </View>
            <View className="flex-1 min-w-0">
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                {filePath.split('/').pop() || filePath}
              </Text>
              <StatusBadge variant="outline" label={getMediaTypeLabel()} className="mt-1" />
            </View>
          </View>
        </View>

        {/* Verdict */}
        <View className="mb-6 rounded-lg p-4 border border-border bg-card">
          <View className="flex-row items-center gap-2 mb-3">
            <VerdictIcon className={`w-5 h-5 ${verdictInfo.color}`} />
            <Text className="text-sm font-medium text-foreground">Detection Result</Text>
          </View>
          <View className="flex-row items-center justify-between mb-2">
            <Text className={`font-semibold ${verdictInfo.color}`}>{verdictInfo.label}</Text>
            <Text className="text-sm text-muted-foreground">
              {(confidence * 100).toFixed(1)}% confidence
            </Text>
          </View>
          {/* Progress bar */}
          <View className="h-2 bg-muted rounded-full overflow-hidden mt-2">
            <View
              className={`h-full ${verdictInfo.color.replace('text-', 'bg-').replace('-600', '-500').replace('-400', '-500')}`}
              style={{ width: `${confidence * 100}%` }}
            />
          </View>
        </View>

        {/* Indicators */}
        {indicators.length > 0 && (
          <View className="mb-4">
            <View className="flex-row items-center gap-2 mb-3">
              <Info className="w-4 h-4 text-muted-foreground" />
              <Text className="text-sm font-medium text-foreground">
                Detection Indicators ({indicators.length})
              </Text>
            </View>
            <View className="gap-2">
              {indicators.map((indicator, idx) => (
                <View
                  key={idx}
                  className="bg-card border border-border rounded-lg p-3"
                >
                  <View className="flex-row items-start justify-between mb-1">
                    <Text className="text-sm font-medium text-foreground flex-1">
                      {indicator.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </Text>
                    <StatusBadge variant="outline" label={`${(indicator.score * 100).toFixed(0)}%`} />
                  </View>
                  {indicator.description && (
                    <Text className="text-xs text-muted-foreground mt-1">
                      {indicator.description}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Analysis ID */}
        {analysisId && (
          <Text className="text-xs text-muted-foreground">
            Analysis ID: {analysisId}
          </Text>
        )}
      </ScrollView>
    </ToolViewCard>
  );
}
