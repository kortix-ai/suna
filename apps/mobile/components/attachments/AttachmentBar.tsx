import React from 'react';
import { View, ScrollView, Image, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X, FileText, File } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import type { Attachment } from '@/hooks/useChat';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

interface AttachmentBarProps {
  attachments: Attachment[];
  onRemove: (index: number) => void;
}

export function AttachmentBar({ attachments, onRemove }: AttachmentBarProps) {
  const { colorScheme } = useColorScheme();
  if (attachments.length === 0) return null;
  const uploadingCount = attachments.filter(a => a.status === 'uploading' || a.isUploading).length;
  
  const MAX_VISIBLE = 3;
  const visibleAttachments = attachments.slice(0, MAX_VISIBLE);
  const remainingCount = Math.max(0, attachments.length - MAX_VISIBLE);

  return (
    <AnimatedView
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      className="px-3 pb-2"
    >
      {uploadingCount > 0 && (
        <View className="flex-row items-center mb-1.5 px-1">
          <View className="w-1 h-1 rounded-full bg-primary mr-1.5" />
          <Text className="text-[11px] font-roobert text-muted-foreground">
            Uploading {uploadingCount}...
          </Text>
        </View>
      )}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 6 }}
        className="flex-row"
        style={{ overflow: 'visible' }}
      >
        {visibleAttachments.map((attachment, index) => (
          <AttachmentItem
            key={`${attachment.uri}-${index}`}
            attachment={attachment}
            index={index}
            onRemove={onRemove}
          />
        ))}
        {remainingCount > 0 && (
          <RemainingAttachmentsCard count={remainingCount} />
        )}
      </ScrollView>
    </AnimatedView>
  );
}

function RemainingAttachmentsCard({ count }: { count: number }) {
  const { colorScheme } = useColorScheme();

  return (
    <AnimatedView
      entering={FadeIn.duration(200)}
      className="relative"
    >
      <View
        className="rounded-2xl overflow-hidden bg-card border border-border/50"
        style={{ 
          width: 80,
          height: 80,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: colorScheme === 'dark' ? 0.3 : 0.05,
          shadowRadius: 2,
        }}
      >
        <View className="items-center justify-center w-full h-full">
          <Text className="text-2xl font-roobert-semibold text-foreground">
            +{count}
          </Text>
        </View>
      </View>
    </AnimatedView>
  );
}


function AttachmentItem({
  attachment,
  index,
  onRemove,
}: {
  attachment: Attachment;
  index: number;
  onRemove: (index: number) => void;
}) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);
  const removeScale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const removeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: removeScale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.96, { damping: 20, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 20, stiffness: 400 });
  };

  const handleRemove = () => {
    log.log('🗑️ Removing attachment:', index);
    onRemove(index);
  };

  const handleRemovePressIn = () => {
    removeScale.value = withSpring(0.85, { damping: 20, stiffness: 400 });
  };

  const handleRemovePressOut = () => {
    removeScale.value = withSpring(1, { damping: 20, stiffness: 400 });
  };

  const isUploading = attachment.status === 'uploading' || attachment.isUploading;
  const hasError = attachment.status === 'error' || !!attachment.uploadError;

  return (
    <AnimatedView
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      style={animatedStyle}
      className="relative"
    >
      <Pressable
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        className={`rounded-2xl overflow-hidden ${
          hasError
            ? 'bg-destructive/5 border border-destructive/20'
            : isUploading
            ? 'bg-primary/5 border border-primary/10'
            : 'bg-card border border-border/50'
        }`}
        style={{ 
          width: 80,
          height: 80,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: colorScheme === 'dark' ? 0.3 : 0.05,
          shadowRadius: 2,
        }}
      >
        {(attachment.type === 'image' || attachment.type === 'video') && (
          <View className="relative w-full h-full">
            <Image
              source={{ uri: attachment.uri }}
              style={{ width: '100%', height: '100%' }}
              resizeMode="cover"
            />
            {attachment.type === 'video' && !isUploading && !hasError && (
              <View className="absolute top-1 left-1 bg-black/60 backdrop-blur-sm rounded px-1 py-0.5">
                <Text className="text-[9px] font-roobert-semibold text-white tracking-tight">
                  VID
                </Text>
              </View>
            )}
            {isUploading && (
              <View className="absolute inset-0 bg-black/20 backdrop-blur-[2px] items-center justify-center">
                <View className="bg-white/90 dark:bg-black/80 rounded-full p-1.5">
                  <ActivityIndicator size="small" color={colorScheme === 'dark' ? '#fff' : '#000'} />
                </View>
              </View>
            )}
            {hasError && (
              <View className="absolute inset-0 bg-destructive/10 items-center justify-center">
                <View className="bg-destructive/90 rounded-full p-1">
                  <Icon
                    as={X}
                    size={14}
                    className="text-destructive-foreground"
                    strokeWidth={2}
                  />
                </View>
              </View>
            )}
          </View>
        )}
        {attachment.type === 'document' && (
          <View className="items-center justify-center w-full h-full">
            {!isUploading && !hasError ? (
              <View className="bg-primary/10 rounded-2xl p-2">
                <Icon
                  as={FileText}
                  size={20}
                  className="text-primary"
                  strokeWidth={1.5}
                />
              </View>
            ) : isUploading ? (
              <View className="bg-white/90 dark:bg-black/80 rounded-full p-1.5">
                <ActivityIndicator
                  size="small"
                  color={colorScheme === 'dark' ? '#fff' : '#000'}
                />
              </View>
            ) : (
              <View className="bg-destructive/90 rounded-full p-1">
                <Icon
                  as={X}
                  size={14}
                  className="text-destructive-foreground"
                  strokeWidth={2}
                />
              </View>
            )}
          </View>
        )}
      </Pressable>
      {!isUploading && (
        <AnimatedPressable
          onPress={handleRemove}
          onPressIn={handleRemovePressIn}
          onPressOut={handleRemovePressOut}
          className="absolute top-1 right-1 bg-background border border-border rounded-full items-center justify-center"
          style={[
            {
              width: 28,
              height: 28,
              zIndex: 9999,
              elevation: 5,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: colorScheme === 'dark' ? 0.5 : 0.25,
              shadowRadius: 4,
            },
            removeAnimatedStyle,
          ]}
        >
          <Icon
            as={X}
            size={16}
            className="text-foreground"
            strokeWidth={2.5}
          />
        </AnimatedPressable>
      )}
    </AnimatedView>
  );
}
