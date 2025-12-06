import React, { useState, useEffect } from 'react';
import { View, ScrollView, Pressable, Linking, Dimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  Globe,
  MonitorPlay,
  ExternalLink,
  Code2,
  ImageIcon,
  Loader2,
  AlertTriangle,
} from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { ToolViewCard, StatusBadge, LoadingState, JsonViewer, ImageLoader } from '../shared';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

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

function getToolTitle(toolName: string): string {
  const normalizedName = toolName.toLowerCase();
  const toolTitles: Record<string, string> = {
    'browser-navigate-to': 'Browser Navigate',
    'browser-act': 'Browser Action',
    'browser-extract-content': 'Browser Extract',
    'browser-screenshot': 'Browser Screenshot',
  };
  return toolTitles[normalizedName] || 'Browser';
}

function extractBrowserOperation(name: string): string {
  const normalizedName = name.toLowerCase();
  if (normalizedName.includes('navigate')) return 'Navigate';
  if (normalizedName.includes('screenshot')) return 'Screenshot';
  if (normalizedName.includes('extract')) return 'Extract';
  if (normalizedName.includes('act')) return 'Action';
  return 'Browser';
}

export function BrowserToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
  agentStatus = 'idle',
  messages = [],
}: ToolViewProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [showContext, setShowContext] = useState(false);
  const [progress, setProgress] = useState(100);

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const operation = extractBrowserOperation(name);
  const toolTitle = getToolTitle(name);

  // Extract data directly from structured props
  const url = toolCall.arguments?.url || toolCall.arguments?.target_url || null;
  const parameters = toolCall.arguments || null;

  // Extract result data from toolResult - match frontend logic exactly
  let browserStateMessageId: string | undefined;
  let screenshotUrlFinal: string | null = null;
  let screenshotBase64Final: string | null = null;
  let result: Record<string, any> | null = null;

  // First, try to get screenshot from toolResult.output
  const screenshotUrl = toolResult?.output?.image_url || null;
  const screenshotBase64 = toolResult?.output?.screenshot_base64 || null;

  if (toolResult?.output) {
    const output = toolResult.output;

    if (typeof output === 'object' && output !== null) {
      // Extract screenshot URL and message ID from output
      if (output.image_url) {
        screenshotUrlFinal = output.image_url;
      }
      if (output.screenshot_base64) {
        screenshotBase64Final = output.screenshot_base64;
      }
      if (output.message_id) {
        browserStateMessageId = output.message_id;
      }

      // Set result, excluding message_id
      result = Object.fromEntries(
        Object.entries(output).filter(([k]) => k !== 'message_id')
      ) as Record<string, any>;
    } else if (typeof output === 'string') {
      try {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === 'object') {
          screenshotUrlFinal = parsed.image_url || null;
          screenshotBase64Final = parsed.screenshot_base64 || null;
          browserStateMessageId = parsed.message_id;
          result = Object.fromEntries(
            Object.entries(parsed).filter(([k]) => k !== 'message_id')
          ) as Record<string, any>;
        } else {
          result = { message: output };
        }
      } catch {
        result = { message: output };
      }
    }
  }

  // Try to find browser state message if we have a message_id (frontend logic)
  if (!screenshotUrlFinal && !screenshotBase64Final && browserStateMessageId && messages.length > 0) {
    const browserStateMessage = messages.find(
      (msg) =>
        (msg.type as string) === 'browser_state' &&
        msg.message_id === browserStateMessageId,
    );

    if (browserStateMessage) {
      try {
        const browserStateContent = typeof browserStateMessage.content === 'string'
          ? JSON.parse(browserStateMessage.content)
          : browserStateMessage.content;

        if (browserStateContent && typeof browserStateContent === 'object') {
          screenshotBase64Final = browserStateContent?.screenshot_base64 || null;
          screenshotUrlFinal = browserStateContent?.image_url || null;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  const isRunning = isStreaming || agentStatus === 'running';
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;
  const hasScreenshot = !!(screenshotUrlFinal || screenshotBase64Final);
  const hasContext = !!(result || parameters);

  // Progress indicator during streaming
  useEffect(() => {
    if (isRunning) {
      setProgress(0);
      const timer = setInterval(() => {
        setProgress((prevProgress) => {
          if (prevProgress >= 95) {
            clearInterval(timer);
            return prevProgress;
          }
          return prevProgress + 2;
        });
      }, 500);
      return () => clearInterval(timer);
    } else {
      setProgress(100);
    }
  }, [isRunning]);


  const handleOpenUrl = async () => {
    if (!url) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      }
    } catch (err) {
      console.error('Failed to open URL:', err);
    }
  };

  const imageSource = screenshotUrlFinal
    ? { uri: screenshotUrlFinal }
    : screenshotBase64Final
      ? { uri: `data:image/jpeg;base64,${screenshotBase64Final}` }
      : null;

  const renderScreenshot = () => {
    if (!imageSource) return null;

    // Calculate proper image dimensions for mobile
    // Browser screenshots are typically 16:9 aspect ratio
    const containerPadding = 16;
    const imageWidth = SCREEN_WIDTH - (containerPadding * 2);
    const aspectRatio = 16 / 9;
    const calculatedHeight = imageWidth / aspectRatio;

    return (
      <View className="w-full items-center justify-center p-4">
        <View 
          className="bg-card border border-border rounded-2xl overflow-hidden"
          style={{
            width: imageWidth,
            maxWidth: '100%',
          }}
        >
          <ImageLoader
            source={imageSource}
            resizeMode="contain"
            style={{
              width: imageWidth,
              height: calculatedHeight,
              minHeight: 300,
            }}
            className="w-full"
          />
        </View>
      </View>
    );
  };

  // Show loading state during streaming with no screenshot
  if (isStreaming && !hasScreenshot && !showContext) {
    return (
      <ToolViewCard
        header={{
          icon: MonitorPlay,
          iconColor: 'text-primary',
          iconBgColor: 'bg-primary/10 border-primary/20',
          subtitle: 'BROWSER',
          title: toolTitle,
          isSuccess: actualIsSuccess,
          isStreaming: true,
          rightContent: <StatusBadge variant="streaming" label="Processing" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={MonitorPlay}
            iconColor="text-primary"
            bgColor="bg-primary/10"
            title={isRunning ? 'Browser action in progress' : `${operation} in progress`}
            filePath={url || 'Processing browser action...'}
            showProgress={true}
            progressText="Loading browser..."
          />
        </View>
      </ToolViewCard>
    );
  }

  return (
    <ToolViewCard
      header={{
        icon: MonitorPlay,
        iconColor: 'text-primary',
        iconBgColor: 'bg-primary/10 border-primary/20',
        subtitle: 'BROWSER',
        title: toolTitle,
        isSuccess: actualIsSuccess,
        isStreaming: isStreaming,
        rightContent: (
          <View className="flex-row items-center gap-2">
            {hasScreenshot && hasContext && (
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setShowContext(!showContext);
                }}
                className="h-8 w-8 items-center justify-center rounded-lg active:opacity-70"
                style={{
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
                }}
              >
                <Icon
                  as={showContext ? ImageIcon : Code2}
                  size={16}
                  className="text-foreground"
                />
              </Pressable>
            )}
            {!isStreaming && (
              <StatusBadge
                variant={actualIsSuccess ? 'success' : 'error'}
                label={actualIsSuccess ? 'Success' : 'Failed'}
              />
            )}
            {isStreaming && <StatusBadge variant="streaming" label="Processing" />}
          </View>
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          <View className="flex-row items-center gap-2 flex-1 min-w-0">
            {!isRunning && operation && (
              <View
                className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full border"
                style={{
                  borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                }}
              >
                <Icon as={Globe} size={12} className="text-foreground" />
                <Text className="text-xs font-roobert-medium text-foreground">
                  {operation}
                </Text>
              </View>
            )}
            {url && (
              <Pressable
                onPress={handleOpenUrl}
                className="flex-row items-center gap-1.5 flex-1 min-w-0 active:opacity-70"
              >
                <Icon as={Globe} size={12} className="text-primary" />
                <Text className="text-xs text-primary flex-1" numberOfLines={1}>
                  {url}
                </Text>
                <Icon as={ExternalLink} size={12} className="text-primary" />
              </Pressable>
            )}
          </View>
          {(toolTimestamp || assistantTimestamp) && !isRunning && (
            <Text className="text-xs text-muted-foreground ml-2">
              {toolTimestamp
                ? formatTimestamp(toolTimestamp)
                : assistantTimestamp
                  ? formatTimestamp(assistantTimestamp)
                  : ''}
            </Text>
          )}
        </View>
      }
    >
      <View className="flex-1 w-full">
        {showContext && hasContext ? (
          <ScrollView className="flex-1 w-full" showsVerticalScrollIndicator={false}>
            <View className="p-4 gap-4">
              {parameters && (
                <View className="gap-2">
                  <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                    Input
                  </Text>
                  <JsonViewer data={parameters} title="INPUT" defaultExpanded={true} />
                </View>
              )}

              {result && (
                <View className="gap-2">
                  <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                    Output
                  </Text>
                  <JsonViewer data={result} title="OUTPUT" defaultExpanded={true} />
                </View>
              )}
            </View>
          </ScrollView>
        ) : hasScreenshot ? (
          <ScrollView className="flex-1 w-full" showsVerticalScrollIndicator={false}>
            {renderScreenshot()}
            {isRunning && (
              <View className="px-4 pb-4">
                <View className="bg-muted/50 border border-border rounded-xl p-3">
                  <View className="flex-row items-center gap-2">
                    <Icon as={Loader2} size={14} className="text-primary" />
                    <Text className="text-xs text-muted-foreground">
                      Browser action in progress...
                    </Text>
                  </View>
                </View>
              </View>
            )}
          </ScrollView>
        ) : (
          <View className="flex-1 w-full items-center justify-center py-12 px-6">
            <View className="bg-primary/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
              <Icon as={MonitorPlay} size={40} className="text-primary" />
            </View>
            <Text className="text-xl font-roobert-semibold mb-2 text-foreground">
              {isRunning ? 'Browser action in progress' : 'Browser action completed'}
            </Text>
            <Text className="text-sm text-muted-foreground text-center mb-4">
              {isRunning
                ? 'Switch to the Browser tab to see the live browser view.'
                : 'Screenshot will appear here when available.'}
            </Text>
            {url && (
              <Pressable
                onPress={handleOpenUrl}
                className="bg-card border border-border rounded-xl px-4 py-3 w-full active:opacity-70"
              >
                <View className="flex-row items-center gap-2">
                  <Icon as={ExternalLink} size={14} className="text-primary" />
                  <Text className="text-sm text-primary flex-1" numberOfLines={1}>
                    Visit URL
                  </Text>
                </View>
              </Pressable>
            )}
          </View>
        )}
      </View>
    </ToolViewCard>
  );
}
