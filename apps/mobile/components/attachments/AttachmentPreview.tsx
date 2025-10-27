import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { FileText, X, Loader2, AlertCircle } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Image, Pressable, View, ActivityIndicator } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import type { Attachment } from '@/hooks/useChat';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

interface AttachmentPreviewProps {
  attachments: Attachment[];
  onRemove: (index: number) => void;
}

interface AttachmentItemProps {
  attachment: Attachment;
  index: number;
  onRemove: (index: number) => void;
}

// Format file size
const formatSize = (bytes?: number): string => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

function AttachmentItem({ attachment, index, onRemove }: AttachmentItemProps) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);
  const removeScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(1);

  // Pulse animation for uploading state
  React.useEffect(() => {
    if (attachment.isUploading) {
      pulseOpacity.value = withRepeat(
        withTiming(0.6, { duration: 800 }),
        -1,
        true
      );
    } else {
      pulseOpacity.value = withTiming(1, { duration: 300 });
    }
  }, [attachment.isUploading]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: pulseOpacity.value,
  }));

  const removeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: removeScale.value }],
  }));

  const handleRemove = () => {
    console.log('🗑️ Removing attachment:', {
      type: attachment.type,
      name: attachment.name || 'unnamed',
      index,
    });
    onRemove(index);
  };

  const displayName = attachment.name || `${attachment.type}.file`;
  const fileSize = formatSize(attachment.size);
  const isUploading = attachment.isUploading;
  const hasError = !!attachment.uploadError;

  return (
    <View className="relative mr-2 mb-2">
      <AnimatedPressable
        onPressIn={() => {
          scale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          scale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        style={animatedStyle}
      >
        {/* Image/Video Preview */}
        {(attachment.type === 'image' || attachment.type === 'video') && (
          <View className="relative rounded-2xl overflow-hidden border border-border bg-card">
            <Image
              source={{ uri: attachment.uri }}
              style={{ width: 80, height: 80 }}
              resizeMode="cover"
            />
            {attachment.type === 'video' && !isUploading && !hasError && (
              <View className="absolute inset-0 bg-black/30 items-center justify-center">
                <View className="bg-white/90 rounded-full px-2 py-1">
                  <Text className="text-xs font-roobert-semibold text-black">VIDEO</Text>
                </View>
              </View>
            )}
            
            {/* Upload Progress Overlay */}
            {isUploading && (
              <View className="absolute inset-0 bg-black/50 items-center justify-center">
                <ActivityIndicator size="small" color="#ffffff" />
                {attachment.uploadProgress !== undefined && (
                  <Text className="text-white text-xs font-roobert-medium mt-1">
                    {Math.round(attachment.uploadProgress)}%
                  </Text>
                )}
              </View>
            )}
            
            {/* Error Overlay */}
            {hasError && (
              <View className="absolute inset-0 bg-destructive/80 items-center justify-center">
                <Icon 
                  as={AlertCircle} 
                  size={20} 
                  className="text-destructive-foreground"
                  strokeWidth={2}
                />
              </View>
            )}
          </View>
        )}

        {/* Document Preview */}
        {attachment.type === 'document' && (
          <View className="rounded-2xl overflow-hidden border border-border bg-card p-3" style={{ width: 80, height: 80 }}>
            <View className="flex-1 items-center justify-center">
              {!isUploading && !hasError && (
                <>
                  <View className="bg-primary/10 rounded-full p-2 mb-1">
                    <Icon 
                      as={FileText} 
                      size={20} 
                      className="text-primary"
                      strokeWidth={2}
                    />
                  </View>
                  {fileSize && (
                    <Text className="text-foreground/60 text-xs font-roobert" numberOfLines={1}>
                      {fileSize}
                    </Text>
                  )}
                </>
              )}
              
              {/* Upload Progress */}
              {isUploading && (
                <View className="items-center">
                  <ActivityIndicator 
                    size="small" 
                    color={colorScheme === 'dark' ? '#ffffff' : '#000000'} 
                  />
                  {attachment.uploadProgress !== undefined && (
                    <Text className="text-foreground/80 text-xs font-roobert-medium mt-2">
                      {Math.round(attachment.uploadProgress)}%
                    </Text>
                  )}
                </View>
              )}
              
              {/* Error State */}
              {hasError && (
                <View className="items-center">
                  <Icon 
                    as={AlertCircle} 
                    size={24} 
                    className="text-destructive"
                    strokeWidth={2}
                  />
                  <Text className="text-destructive text-xs font-roobert-medium mt-1">
                    Failed
                  </Text>
                </View>
              )}
            </View>
          </View>
        )}

        {/* Remove Button - hide during upload, show during error */}
        {!isUploading && (
          <AnimatedPressable
            onPressIn={() => {
              removeScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
              removeScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            onPress={handleRemove}
            className="absolute -top-1.5 -right-1.5 bg-destructive rounded-full items-center justify-center shadow-sm"
            style={[{ width: 20, height: 20 }, removeAnimatedStyle]}
          >
            <Icon 
              as={X} 
              size={12} 
              className="text-destructive-foreground"
              strokeWidth={3}
            />
          </AnimatedPressable>
        )}
      </AnimatedPressable>

      {/* File Name (for documents) */}
      {attachment.type === 'document' && attachment.name && !hasError && (
        <Text 
          className="text-foreground/80 text-xs font-roobert mt-1" 
          numberOfLines={2}
          style={{ width: 80 }}
        >
          {displayName}
        </Text>
      )}
      
      {/* Error Message */}
      {hasError && attachment.uploadError && (
        <Text 
          className="text-destructive text-xs font-roobert-medium mt-1" 
          numberOfLines={2}
          style={{ width: 80 }}
        >
          {attachment.uploadError}
        </Text>
      )}
    </View>
  );
}

/**
 * AttachmentPreview Component
 * 
 * Displays a grid of attachment previews with remove functionality.
 * Supports images, videos, and documents.
 * 
 * Features:
 * - Image thumbnails
 * - Video badges
 * - Document icons with file size
 * - Remove button on each attachment
 * - Upload progress indicators
 * - Error state display
 * - Smooth animations
 * - Clean layout
 */
export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  if (attachments.length === 0) {
    return null;
  }

  const uploadingCount = attachments.filter(a => a.isUploading).length;
  const errorCount = attachments.filter(a => a.uploadError).length;

  return (
    <View>
      <View className="flex-row flex-wrap">
        {attachments.map((attachment, index) => (
          <AttachmentItem
            key={`${attachment.uri}-${index}`}
            attachment={attachment}
            index={index}
            onRemove={onRemove}
          />
        ))}
      </View>
      
      {/* Attachment Count with Status */}
      <View className="flex-row items-center mt-1">
        <Text className="text-foreground/60 text-xs font-roobert">
          {attachments.length} {attachments.length === 1 ? 'attachment' : 'attachments'}
        </Text>
        
        {uploadingCount > 0 && (
          <Text className="text-foreground/60 text-xs font-roobert ml-2">
            • Uploading {uploadingCount}
          </Text>
        )}
        
        {errorCount > 0 && (
          <Text className="text-destructive text-xs font-roobert-medium ml-2">
            • {errorCount} failed
          </Text>
        )}
      </View>
    </View>
  );
}
