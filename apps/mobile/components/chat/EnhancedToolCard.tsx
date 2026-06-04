/**
 * Enhanced Tool Card with support for web search favicons and image search thumbnails
 * Extends CompactToolCard functionality with visual extras like frontend has
 */

import React, { useMemo, useCallback } from 'react';
import { View, Pressable, Image, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, AlertCircle, CircleDashed } from 'lucide-react-native';
import { getToolIcon } from '@/lib/icons/tool-icons';
import { getUserFriendlyToolName, parseToolMessage, safeJsonParse } from '@agentpress/shared';
import type { UnifiedMessage } from '@agentpress/shared';
import { useColorScheme } from 'nativewind';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Get favicon URL for a domain using Google's favicon service
 */
function getFavicon(url: string): string | null {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  } catch {
    return null;
  }
}

/**
 * Extract web search URLs from tool result
 */
function extractWebSearchUrls(toolResult: { output?: any } | undefined): string[] {
  if (!toolResult?.output) return [];

  const extractFromOutput = (output: any): string[] => {
    if (!output) return [];

    // Handle string output
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output);
      } catch {
        return [];
      }
    }

    if (output.batch_mode && Array.isArray(output.results)) {
      const allUrls: string[] = [];
      for (const batch of output.results) {
        if (batch.results && Array.isArray(batch.results)) {
          allUrls.push(...batch.results.map((r: any) => r.url).filter(Boolean));
        }
      }
      return allUrls.slice(0, 4);
    }

    if (Array.isArray(output.results)) {
      return output.results.slice(0, 4).map((r: any) => r.url).filter(Boolean);
    }

    if (Array.isArray(output)) {
      return output.slice(0, 4).map((r: any) => r.url).filter(Boolean);
    }

    return [];
  };

  return extractFromOutput(toolResult.output);
}

/**
 * Extract image search URLs from tool result
 */
function extractImageSearchUrls(toolResult: { output?: any } | undefined): string[] {
  if (!toolResult?.output) return [];

  try {
    let output = toolResult.output;

    // Handle string output
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output);
      } catch {
        return [];
      }
    }

    // Handle batch results
    if (output.batch_results && Array.isArray(output.batch_results)) {
      const allImages: string[] = [];
      for (const batch of output.batch_results) {
        if (batch.images && Array.isArray(batch.images)) {
          allImages.push(...batch.images);
        }
      }
      return allImages.slice(0, 5);
    }

    // Handle direct images array
    if (Array.isArray(output.images)) {
      return output.images.slice(0, 5);
    }
  } catch (e) {
    log.error('[extractImageSearchUrls] Error:', e);
  }
  return [];
}

interface EnhancedToolCardProps {
  message: UnifiedMessage;
  onPress?: () => void;
}

export const EnhancedToolCard = React.memo(function EnhancedToolCard({
  message,
  onPress,
}: EnhancedToolCardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
    opacity.value = 0.7;
  }, []);

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
    opacity.value = 1;
  }, []);

  const parsed = useMemo(() => {
    if (!message) return null;
    return parseToolMessage(message);
  }, [message]);

  const toolName = parsed?.toolName || 'Unknown Tool';
  const displayName = getUserFriendlyToolName(toolName);
  const isError = parsed?.result ? !parsed.result.success : false;
  const IconComponent = getToolIcon(toolName);

  // Check if this is a web search or image search tool
  const isWebSearch = toolName === 'web-search' || toolName === 'web_search';
  const isImageSearch = toolName === 'image-search' || toolName === 'image_search';

  // Extract URLs/images
  const websiteUrls = useMemo(() => {
    if (!isWebSearch || !parsed?.result) return [];
    return extractWebSearchUrls(parsed.result);
  }, [isWebSearch, parsed?.result]);

  const imageUrls = useMemo(() => {
    if (!isImageSearch || !parsed?.result) return [];
    return extractImageSearchUrls(parsed.result);
  }, [isImageSearch, parsed?.result]);

  const favicons = useMemo(() => {
    return websiteUrls.map(getFavicon).filter(Boolean) as string[];
  }, [websiteUrls]);

  return (
    <View style={styles.container}>
      {/* Tool button row */}
      <AnimatedPressable
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onPress={onPress}
        style={animatedStyle}
        disabled={!onPress}
      >
        <View style={styles.toolRow}>
          <View style={styles.iconContainer}>
            <Icon
              as={isError ? AlertCircle : IconComponent}
              size={16}
              className={isError ? 'text-destructive' : 'text-muted-foreground'}
            />
          </View>

          <Text className="text-sm font-roobert-medium text-muted-foreground" numberOfLines={1}>
            {displayName}
          </Text>

          {/* Favicon stack for web search */}
          {favicons.length > 0 && (
            <View style={styles.faviconStack}>
              {favicons.map((favicon, idx) => (
                <Image
                  key={idx}
                  source={{ uri: favicon }}
                  style={[
                    styles.favicon,
                    {
                      marginLeft: idx > 0 ? -6 : 0,
                      zIndex: favicons.length - idx,
                      borderColor: isDark ? '#27272a' : '#ffffff',
                    },
                  ]}
                />
              ))}
            </View>
          )}
        </View>
      </AnimatedPressable>

      {/* Image thumbnails for image search */}
      {imageUrls.length > 0 && (
        <View style={styles.imageGrid}>
          {imageUrls.slice(0, 5).map((url, idx) => (
            <Pressable
              key={idx}
              onPress={onPress}
              style={[
                styles.imageThumbnail,
                { borderColor: isDark ? '#3f3f46' : '#e4e4e7' },
              ]}
            >
              <Image
                source={{ uri: url }}
                style={styles.thumbnailImage}
                resizeMode="cover"
              />
            </Pressable>
          ))}
          {imageUrls.length > 5 && (
            <Pressable
              onPress={onPress}
              style={[
                styles.imageThumbnail,
                styles.moreIndicator,
                {
                  backgroundColor: isDark ? '#27272a' : '#f4f4f5',
                  borderColor: isDark ? '#3f3f46' : '#e4e4e7',
                },
              ]}
            >
              <Text className="text-xs font-roobert-medium text-muted-foreground">
                +{imageUrls.length - 5}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  iconContainer: {
    width: 20,
    height: 20,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faviconStack: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 6,
  },
  favicon: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    backgroundColor: '#ffffff',
  },
  imageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  imageThumbnail: {
    width: 64,
    height: 64,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  moreIndicator: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default EnhancedToolCard;
