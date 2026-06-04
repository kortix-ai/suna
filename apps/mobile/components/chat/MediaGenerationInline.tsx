/**
 * Inline media generation component for the chat
 * Shows a shimmer loading effect while generating, then the actual image/video
 */

import React, { useEffect, useState, useMemo } from 'react';
import { View, Pressable, Image, StyleSheet, Dimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Image as ImageIcon, Video, AlertCircle, CheckCircle2 } from 'lucide-react-native';
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
 * Shimmer loading box for media generation - full width
 */
function ShimmerBox({ aspectVideo = false }: { aspectVideo?: boolean }) {
  const shimmerPosition = useSharedValue(0);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const screenWidth = Dimensions.get('window').width;

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
      [-screenWidth * 2, screenWidth * 2]
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
          width: '100%',
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
          style={[StyleSheet.absoluteFill, { width: screenWidth * 2 }]}
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
 * Inline image display with loading state - full width, pressable
 */
function InlineImage({ filePath, sandboxId, onPress }: { filePath: string; sandboxId?: string; onPress?: () => void }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [imageError, setImageError] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState(1);

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
        const uri = reader.result as string;
        setImageUri(uri);
        // Get image dimensions
        Image.getSize(uri, (width, height) => {
          if (width && height) {
            setAspectRatio(width / height);
          }
        }, () => {});
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
    <Pressable
      onPress={onPress}
      style={[
        styles.imageContainer,
        {
          borderColor: isDark ? '#3f3f46' : '#e4e4e7',
        },
      ]}
    >
      <Image
        source={{ uri: imageUri }}
        style={[styles.image, { aspectRatio }]}
        resizeMode="contain"
        onError={() => setImageError(true)}
      />
    </Pressable>
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
  const isComplete = !!toolResult;
  const media = isComplete ? extractGeneratedMedia(toolResult?.output) : null;
  
  // Detect if this is a video generation based on tool arguments
  const isVideoGeneration = toolCall.arguments?.video_options !== undefined;
  
  const rawToolName = toolCall.function_name;
  const IconComponent = getToolIcon(rawToolName);
  const displayName = getUserFriendlyToolName(rawToolName) || 'Generate Media';

  return (
    <View style={styles.container}>
      {/* Tool button - matches CompactToolCard exactly */}
      <Pressable
        onPress={onToolClick}
        disabled={!isComplete}
        style={styles.toolButton}
      >
        <View className="w-5 h-5 rounded-md items-center justify-center">
          <Icon as={IconComponent} size={16} className="text-muted-foreground" />
        </View>
        <Text className="text-sm font-roobert-medium text-muted-foreground ml-1" numberOfLines={1}>
          {displayName}
        </Text>
        {!isComplete ? (
          <KortixLoader size="small" />
        ) : (
          <Icon as={CheckCircle2} size={12} className="text-emerald-500 ml-2" />
        )}
      </Pressable>

      {/* Media preview below - full width, clickable to open tool */}
      {!isComplete ? (
        <ShimmerBox aspectVideo={isVideoGeneration} />
      ) : media?.type === 'image' ? (
        <InlineImage filePath={media.path} sandboxId={sandboxId} onPress={onToolClick} />
      ) : media?.type === 'video' ? (
        <InlineImage filePath={media.path} sandboxId={sandboxId} onPress={onToolClick} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  toolButton: {
    flexDirection: 'row',
    alignItems: 'center',
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
    width: '100%',
  },
  image: {
    width: '100%',
  },
  errorContainer: {
    borderRadius: 16,
    borderWidth: 1,
    width: '100%',
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
});

