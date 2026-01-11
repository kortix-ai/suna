import React, { useState, useEffect } from 'react';
import { View, ScrollView, Pressable, Linking, Dimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui/kortix-loader';
import {
  Globe,
  MonitorPlay,
  ExternalLink,
  Code2,
  ImageIcon,
  AlertTriangle,
} from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import type { UnifiedMessage } from '@/api/types';
import { ToolViewCard, StatusBadge, LoadingState, JsonViewer, ImageLoader } from '../shared';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';
import { log } from '@/lib/logger';

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
  const normalizedName = toolName.toLowerCase().replace(/_/g, '-');
  const toolTitles: Record<string, string> = {
    'browser-navigate-to': 'Browser Navigate',
    'browser-act': 'Browser Action',
    'browser-extract-content': 'Browser Extract',
    'browser-screenshot': 'Browser Screenshot',
    'browser-click-element': 'Browser Click',
    'browser-input-text': 'Browser Input',
    'browser-scroll-down': 'Browser Scroll',
    'browser-scroll-up': 'Browser Scroll',
    'browser-go-back': 'Browser Navigate',
    'browser-wait': 'Browser Wait',
    'browser-send-keys': 'Browser Send Keys',
    'browser-switch-tab': 'Browser Switch Tab',
    'browser-close-tab': 'Browser Close Tab',
    'browser-scroll-to-text': 'Browser Scroll',
    'browser-get-dropdown-options': 'Browser Get Options',
    'browser-select-dropdown-option': 'Browser Select',
    'browser-drag-drop': 'Browser Drag & Drop',
    'browser-click-coordinates': 'Browser Click',
  };
  return toolTitles[normalizedName] || 'Browser';
}

function extractBrowserOperation(name: string): string {
  const normalizedName = name.toLowerCase().replace(/_/g, '-');
  if (normalizedName.includes('navigate') || normalizedName.includes('go-back')) return 'Navigate';
  if (normalizedName.includes('screenshot')) return 'Screenshot';
  if (normalizedName.includes('extract')) return 'Extract';
  if (normalizedName.includes('click')) return 'Click';
  if (normalizedName.includes('input') || normalizedName.includes('send-keys')) return 'Input';
  if (normalizedName.includes('scroll')) return 'Scroll';
  if (normalizedName.includes('switch-tab') || normalizedName.includes('close-tab')) return 'Tab';
  if (normalizedName.includes('dropdown') || normalizedName.includes('select')) return 'Select';
  if (normalizedName.includes('drag') || normalizedName.includes('drop')) return 'Drag & Drop';
  if (normalizedName.includes('wait')) return 'Wait';
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
  const [progress, setProgress] = useState(100);

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const operation = extractBrowserOperation(name);
  const toolTitle = getToolTitle(name);

  // Extract data directly from structured props
  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => { try { return JSON.parse(toolCall.arguments); } catch { return {}; } })()
      : {};
  
  const url = args?.url || args?.target_url || null;
  const parameters = args || null;

  // Extract result data from toolResult with proper parsing - match frontend logic exactly
  let browserStateMessageId: string | undefined;
  let screenshotUrlFinal: string | null = null;
  let screenshotBase64Final: string | null = null;
  let result: Record<string, any> | null = null;

  if (toolResult?.output) {
    let output = toolResult.output;
    
    // Handle string outputs that need parsing (backward compatibility)
    if (typeof output === 'string') {
      try {
        // Try to parse as JSON
        const parsed = JSON.parse(output);
        if (typeof parsed === 'object' && parsed !== null) {
          output = parsed;
        } else {
          // If parsing succeeds but result is not an object, treat as message
          result = { message: output };
          output = null;
        }
      } catch (e) {
        // Not valid JSON, treat as plain message
        result = { message: output };
        output = null;
      }
    }
    
    // Process object output
    if (output && typeof output === 'object' && output !== null) {
      // Extract screenshot URL and message ID from output
      if (output.image_url) {
        // Clean up URL - remove trailing ? and whitespace
        screenshotUrlFinal = String(output.image_url).trim().replace(/\?+$/, '');
      }
      if (output.screenshot_base64) {
        screenshotBase64Final = String(output.screenshot_base64).trim();
      }
      if (output.message_id) {
        browserStateMessageId = String(output.message_id).trim();
      }
      
      // Set result, excluding message_id and screenshot fields for cleaner display
      result = Object.fromEntries(
        Object.entries(output).filter(([k]) => 
          k !== 'message_id' && 
          k !== 'image_url' && 
          k !== 'screenshot_base64'
        )
      ) as Record<string, any>;
      
      // If result is empty, at least show success/message
      if (Object.keys(result).length === 0 && output.message) {
        result = { message: output.message };
      }
    }
  }

  // Try to find browser state message if we have a message_id but no screenshot yet
  // This is a fallback - the screenshot should already be in toolResult.output
  if (!screenshotUrlFinal && !screenshotBase64Final && browserStateMessageId && messages && messages.length > 0) {
    const browserStateMessage: UnifiedMessage | undefined = messages.find(
      (msg: UnifiedMessage) =>
        (msg.type as string) === 'browser_state' &&
        msg.message_id === browserStateMessageId,
    );

    if (browserStateMessage) {
      try {
        const browserStateContent = typeof browserStateMessage.content === 'string'
          ? JSON.parse(browserStateMessage.content)
          : browserStateMessage.content;

        if (browserStateContent && typeof browserStateContent === 'object') {
          if (browserStateContent.screenshot_base64) {
            screenshotBase64Final = String(browserStateContent.screenshot_base64).trim();
          }
          if (browserStateContent.image_url) {
            // Clean up URL - remove trailing ? and whitespace
            screenshotUrlFinal = String(browserStateContent.image_url).trim().replace(/\?+$/, '');
          }
        }
        
        log.log('[BrowserToolView] Found browser_state message:', {
          messageId: browserStateMessageId,
          hasImageUrl: !!screenshotUrlFinal,
          hasBase64: !!screenshotBase64Final,
        });
      } catch (e) {
        log.log('[BrowserToolView] Error parsing browser_state message:', e);
      }
    } else {
      log.log('[BrowserToolView] Browser state message not found:', {
        messageId: browserStateMessageId,
        availableMessages: messages.map(m => ({ type: m.type, id: m.message_id })),
      });
    }
  }

  // Log extracted data for debugging
  useEffect(() => {
    log.log('[BrowserToolView] Extracted data:', {
      screenshotUrl: screenshotUrlFinal,
      screenshotBase64: screenshotBase64Final ? 'present' : null,
      browserStateMessageId,
      hasResult: !!result,
      toolResultOutput: toolResult?.output,
      toolResultOutputType: typeof toolResult?.output,
    });
  }, [screenshotUrlFinal, screenshotBase64Final, browserStateMessageId, result, toolResult?.output]);

  const isRunning = isStreaming || agentStatus === 'running';
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;
  const hasScreenshot = !!(screenshotUrlFinal || screenshotBase64Final);
  const hasContext = !!(result || parameters);
  
  // For extract operations, prioritize showing extracted content
  const isExtractOperation = name.includes('extract');
  const hasExtractedContent = isExtractOperation && result && Object.keys(result).length > 0;
  const shouldShowExtractedContent = isExtractOperation && hasExtractedContent && !hasScreenshot;
  
  // Default to showing context for extract operations if no screenshot
  const [showContextState, setShowContextState] = useState(shouldShowExtractedContent);
  
  // Update showContextState when operation type changes
  useEffect(() => {
    if (shouldShowExtractedContent) {
      setShowContextState(true);
    }
  }, [shouldShowExtractedContent]);

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
      log.error('Failed to open URL:', err);
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
      <View 
        className="flex-1 items-center justify-center"
        style={{
          minHeight: 600,
          padding: 16,
        }}
      >
        <View 
          className="bg-card border border-border rounded-2xl overflow-hidden"
          style={{
            width: imageWidth,
            maxWidth: '100%',
            backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
            borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
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
            showLoadingState={true}
          />
        </View>
      </View>
    );
  };

  // Show loading state during streaming with no screenshot
  if (isStreaming && !hasScreenshot && !showContextState) {
    return (
      <ToolViewCard
        header={{
          icon: MonitorPlay,
          iconColor: 'text-primary',
          iconBgColor: 'bg-primary/10 border-primary/20',
          subtitle: '',
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
        subtitle: '', // Simplified - just show tool name
        title: toolTitle,
        isSuccess: actualIsSuccess,
        isStreaming: isStreaming,
        showStatus: false, // Don't show status icon in header
        rightContent: (
          <View className="flex-row items-center gap-2">
            {!isRunning && (
              <StatusBadge
                variant={actualIsSuccess ? 'success' : 'error'}
                label={actualIsSuccess ? 'Completed' : 'Failed'}
              />
            )}
            {hasScreenshot && hasContext && (
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setShowContextState(!showContextState);
                }}
                className="h-8 w-8 items-center justify-center rounded-lg active:opacity-70"
                style={{
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
                }}
              >
                <Icon
                  as={showContextState ? ImageIcon : Code2}
                  size={16}
                  className="text-foreground"
                />
              </Pressable>
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
        {showContextState && hasContext ? (
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
          <ScrollView 
            className="flex-1 w-full" 
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              flexGrow: 1,
              justifyContent: 'center',
              alignItems: 'center',
              backgroundColor: isDark ? '#000000' : '#ffffff',
            }}
          >
            {renderScreenshot()}
            {isRunning && (
              <View className="px-4 pb-4 mt-4">
                <View 
                  className="bg-muted/50 border border-border rounded-xl p-3"
                  style={{
                    backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.05)',
                    borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                  }}
                >
                  <View className="flex-row items-center gap-2">
                    <KortixLoader size="small" customSize={14} />
                    <Text className="text-xs text-muted-foreground">
                      Browser action in progress...
                    </Text>
                  </View>
                </View>
              </View>
            )}
          </ScrollView>
        ) : (
          <View 
            className="flex-1 w-full items-center justify-center py-12 px-6"
            style={{
              backgroundColor: isDark 
                ? 'rgba(18, 18, 21, 1)' 
                : 'rgba(255, 255, 255, 1)',
              minHeight: 600,
            }}
          >
            <View 
              className="rounded-full items-center justify-center mb-6"
              style={{
                width: 80,
                height: 80,
                backgroundColor: isDark 
                  ? 'rgba(168, 85, 247, 0.2)' 
                  : 'rgba(168, 85, 247, 0.1)',
              }}
            >
              <Icon 
                as={MonitorPlay} 
                size={40} 
                color={isDark ? '#a855f7' : '#9333ea'}
                strokeWidth={2}
              />
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
                className="bg-card border border-border rounded-xl px-4 py-3 active:opacity-70"
                style={{
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.05)',
                  borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 1 },
                  shadowOpacity: 0.1,
                  shadowRadius: 2,
                  elevation: 2,
                }}
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
