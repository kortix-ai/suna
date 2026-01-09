/**
 * Inline media generation component for the chat
 * Shows a shimmer loading effect while generating, then the actual image/video
 */

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { View, Pressable, Image, StyleSheet, Dimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Play, Pause, Image as ImageIcon, Video, AlertCircle } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  interpolate,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { getToolIcon } from '@/lib/icons/tool-icons';
import { getUserFriendlyToolName } from '@agentpress/shared';
import { useSandboxImageBlob } from '@/lib/files/hooks';
import { KortixLoader } from '@/components/ui/kortix-loader';

type MediaType = 'image' | 'video' | null;

interface MediaGenerationInlineProps {
  toolCall: {
    function_name: string;
    arguments?: Record<string, any>;
    tool_call_id?: string;
  };
  toolResult?: {
    output?: string | Record<string, any>;
    success?: boolean;
  };
  onToolClick: () => void;
  sandboxId?: string;
}

/**
 * Extract generated media path and type from tool output
 */
function extractGeneratedMedia(output: string | Record<string, any> | undefined): { path: string; type: MediaType } | null {
  if (!output) return null;

  // Handle object output
  if (typeof output === 'object') {
    const path = output.generated_image_path || output.image_path || output.file_path || output.path;
    if (path) {
      const isVideo = /\.(mp4|webm|mov)$/i.test(path);
      return { path, type: isVideo ? 'video' : 'image' };
    }
    return null;
  }

  // Handle string output
  if (typeof output === 'string') {
    // Check for video first - supports filenames with spaces
    const videoMatch = output.match(/Video saved as:\s*(?:\/workspace\/)?(.+\.(?:mp4|webm|mov))/i);
    if (videoMatch?.[1]) return { path: videoMatch[1].trim(), type: 'video' };
    
    // Legacy format with underscores
    const directVideoMatch = output.match(/(?:\/workspace\/)?(generated_video_[a-z0-9]+\.(?:mp4|webm|mov))/i);
    if (directVideoMatch?.[1]) return { path: directVideoMatch[1].trim(), type: 'video' };

    // Check for image - supports filenames with spaces
    const imageMatch = output.match(/Image saved as:\s*(?:\/workspace\/)?(.+\.(?:png|jpg|jpeg|webp|gif))/i);
    if (imageMatch?.[1]) return { path: imageMatch[1].trim(), type: 'image' };
    
    // Legacy format with underscores
    const directImageMatch = output.match(/(?:\/workspace\/)?(generated_image_[a-z0-9]+\.(?:png|jpg|jpeg|webp|gif))/i);
    if (directImageMatch?.[1]) return { path: directImageMatch[1].trim(), type: 'image' };
  }

  return null;
}

/**
 * Shimmer loading box for media generation
 */
function ShimmerBox({ aspectVideo = false }: { aspectVideo?: boolean }) {
  const shimmerPosition = useSharedValue(0);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const screenWidth = Dimensions.get('window').width;
  const boxWidth = Math.min(screenWidth * 0.75, 320);

  useEffect(() => {
    shimmerPosition.value = withRepeat(
      withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.ease) }),
      -1,
      false
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => {
    const translateX = interpolate(
      shimmerPosition.value,
      [0, 1],
      [-boxWidth * 2, boxWidth * 2]
    );
    return {
      transform: [{ translateX }],
    };
  });

  return (
    <View
      style={[
        styles.shimmerContainer,
        {
          width: boxWidth,
          aspectRatio: aspectVideo ? 16 / 9 : 1,
          backgroundColor: isDark ? '#27272a' : '#f4f4f5',
          borderColor: isDark ? '#3f3f46' : '#e4e4e7',
        },
      ]}
    >
      {/* Base gradient layer */}
      <LinearGradient
        colors={isDark ? ['#3f3f46', '#52525b'] : ['#e4e4e7', '#d4d4d8']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      />
      
      {/* Shimmer overlay */}
      <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
        <LinearGradient
          colors={[
            'transparent',
            isDark ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.5)',
            'transparent',
          ]}
          style={[StyleSheet.absoluteFill, { width: boxWidth * 2 }]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
        />
      </Animated.View>

      {/* Center icon */}
      <View style={styles.shimmerIconContainer}>
        <Icon
          as={aspectVideo ? Video : ImageIcon}
          size={32}
          className="text-muted-foreground opacity-40"
        />
      </View>
    </View>
  );
}

/**
 * Inline image display with loading state
 */
function InlineImage({ filePath, sandboxId }: { filePath: string; sandboxId?: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const screenWidth = Dimensions.get('window').width;
  const imageWidth = Math.min(screenWidth * 0.75, 320);
  const [imageError, setImageError] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);

  // Normalize path
  const normalizedPath = useMemo(() => {
    if (!filePath) return '';
    return filePath.startsWith('/') ? filePath : `/workspace/${filePath}`;
  }, [filePath]);

  const { data: imageBlob, isLoading } = useSandboxImageBlob(sandboxId, normalizedPath, {
    enabled: !!sandboxId && !!normalizedPath,
  });

  // Convert blob to data URI
  useEffect(() => {
    if (imageBlob instanceof Blob) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImageUri(reader.result as string);
      };
      reader.onerror = () => {
        setImageError(true);
      };
      reader.readAsDataURL(imageBlob);
    }
    
    return () => {
      setImageUri(null);
    };
  }, [imageBlob]);

  if (isLoading || !imageUri) {
    return <ShimmerBox />;
  }

  if (imageError) {
    return (
      <View
        style={[
          styles.errorContainer,
          {
            width: imageWidth,
            backgroundColor: isDark ? '#27272a' : '#f4f4f5',
            borderColor: isDark ? '#3f3f46' : '#e4e4e7',
          },
        ]}
      >
        <Icon as={AlertCircle} size={24} className="text-destructive" />
        <Text className="text-sm text-destructive mt-2">Failed to load image</Text>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.imageContainer,
        {
          width: imageWidth,
          borderColor: isDark ? '#3f3f46' : '#e4e4e7',
        },
      ]}
    >
      <Image
        source={{ uri: imageUri }}
        style={styles.image}
        resizeMode="contain"
        onError={() => setImageError(true)}
      />
    </View>
  );
}

/**
 * Main MediaGenerationInline component
 */
export function MediaGenerationInline({
  toolCall,
  toolResult,
  onToolClick,
  sandboxId,
}: MediaGenerationInlineProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const isComplete = !!toolResult;
  const media = isComplete ? extractGeneratedMedia(toolResult?.output) : null;
  
  // Detect if this is a video generation based on tool arguments
  const isVideoGeneration = toolCall.arguments?.video_options !== undefined;
  
  const rawToolName = toolCall.function_name;
  const IconComponent = getToolIcon(rawToolName);
  const displayName = getUserFriendlyToolName(rawToolName) || 'Generate Media';

  return (
    <View style={styles.container}>
      {/* Tool button - compact style */}
      <Pressable
        onPress={onToolClick}
        style={[
          styles.toolButton,
          {
            backgroundColor: isDark ? '#27272a' : '#fafafa',
            borderColor: isDark ? '#3f3f46' : '#e4e4e7',
          },
        ]}
      >
        <View style={styles.toolButtonContent}>
          <Icon as={IconComponent} size={14} className="text-muted-foreground" />
          <Text className="font-mono text-xs text-foreground ml-1.5" numberOfLines={1}>
            {displayName}
          </Text>
          {!isComplete && (
            <View style={styles.loaderContainer}>
              <KortixLoader size="small" />
            </View>
          )}
        </View>
      </Pressable>

      {/* Media preview below */}
      <View style={styles.mediaContainer}>
        {!isComplete ? (
          <ShimmerBox aspectVideo={isVideoGeneration} />
        ) : media?.type === 'image' ? (
          <InlineImage filePath={media.path} sandboxId={sandboxId} />
        ) : media?.type === 'video' ? (
          // For now, show image placeholder for video - full video player can be added later
          <InlineImage filePath={media.path} sandboxId={sandboxId} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 6,
    gap: 8,
  },
  toolButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  toolButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  loaderContainer: {
    marginLeft: 6,
  },
  shimmerContainer: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  shimmerIconContainer: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageContainer: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    aspectRatio: 1,
  },
  errorContainer: {
    borderRadius: 16,
    borderWidth: 1,
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
});

