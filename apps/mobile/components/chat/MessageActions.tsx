import React, { useState, useEffect } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  interpolate,
} from 'react-native-reanimated';
import { Icon } from '@/components/ui/icon';
import { Copy, Check, Volume2, ThumbsUp, ThumbsDown } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';
import { useVoicePlayerStore } from '@/stores/voice-player-store';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.View;

interface MessageActionsProps {
  text: string;
}

interface ActionButtonProps {
  onPress: () => void;
  icon: any;
  activeIcon?: any;
  isActive?: boolean;
  activeColor?: string;
  disabled?: boolean;
  iconColor: string;
}

function ActionButton({
  onPress,
  icon,
  activeIcon,
  isActive,
  activeColor,
  disabled,
  iconColor
}: ActionButtonProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.85, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      style={[styles.button, animatedStyle, disabled && styles.buttonDisabled]}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Icon
        as={isActive && activeIcon ? activeIcon : icon}
        size={16}
        color={isActive ? activeColor : iconColor}
      />
    </AnimatedPressable>
  );
}

export function MessageActions({ text }: MessageActionsProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);

  const { playText, state: voiceState } = useVoicePlayerStore();
  const isVoiceLoading = voiceState === 'loading';

  const iconColor = isDark ? '#8E8E93' : '#9CA3AF';
  // Primary color for active state
  const primaryColor = isDark ? '#FFFFFF' : '#000000';

  // Animation values for thumbs visibility
  const thumbsUpVisibility = useSharedValue(1);
  const thumbsDownVisibility = useSharedValue(1);

  // Animate thumbs visibility when one is selected
  useEffect(() => {
    if (liked) {
      // Liked - hide thumbs down
      thumbsDownVisibility.value = withTiming(0, { duration: 200 });
      thumbsUpVisibility.value = withSpring(1, { damping: 15, stiffness: 300 });
    } else if (disliked) {
      // Disliked - hide thumbs up
      thumbsUpVisibility.value = withTiming(0, { duration: 200 });
      thumbsDownVisibility.value = withSpring(1, { damping: 15, stiffness: 300 });
    } else {
      // Neither - show both
      thumbsUpVisibility.value = withSpring(1, { damping: 15, stiffness: 300 });
      thumbsDownVisibility.value = withSpring(1, { damping: 15, stiffness: 300 });
    }
  }, [liked, disliked, thumbsUpVisibility, thumbsDownVisibility]);

  const thumbsUpAnimatedStyle = useAnimatedStyle(() => ({
    opacity: thumbsUpVisibility.value,
    transform: [
      { scale: interpolate(thumbsUpVisibility.value, [0, 1], [0.5, 1]) },
    ],
    width: interpolate(thumbsUpVisibility.value, [0, 1], [0, 28]),
    marginRight: interpolate(thumbsUpVisibility.value, [0, 1], [-6, 0]),
  }));

  const thumbsDownAnimatedStyle = useAnimatedStyle(() => ({
    opacity: thumbsDownVisibility.value,
    transform: [
      { scale: interpolate(thumbsDownVisibility.value, [0, 1], [0.5, 1]) },
    ],
    width: interpolate(thumbsDownVisibility.value, [0, 1], [0, 28]),
    marginLeft: interpolate(thumbsDownVisibility.value, [0, 1], [-6, 0]),
  }));

  const handleCopy = async () => {
    if (!text) return;
    await Clipboard.setStringAsync(text);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSpeak = async () => {
    if (!text || isVoiceLoading) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await playText(text);
  };

  const handleLike = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (liked) {
      // Deselect
      setLiked(false);
    } else {
      // Select like, deselect dislike
      setLiked(true);
      setDisliked(false);
    }
  };

  const handleDislike = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (disliked) {
      // Deselect
      setDisliked(false);
    } else {
      // Select dislike, deselect like
      setDisliked(true);
      setLiked(false);
    }
  };

  if (!text?.trim()) return null;

  return (
    <View style={styles.container}>
      {/* Copy button */}
      <ActionButton
        onPress={handleCopy}
        icon={copied ? Check : Copy}
        isActive={copied}
        activeColor={primaryColor}
        iconColor={iconColor}
      />

      {/* Speaker button - COMMENTED OUT */}
      {/* <ActionButton
        onPress={handleSpeak}
        icon={Volume2}
        disabled={isVoiceLoading}
        iconColor={iconColor}
      /> */}

      {/* Thumbs up - animated visibility */}
      <AnimatedView style={[styles.thumbContainer, thumbsUpAnimatedStyle]}>
        <ActionButton
          onPress={handleLike}
          icon={ThumbsUp}
          isActive={liked}
          activeColor={primaryColor}
          iconColor={iconColor}
        />
      </AnimatedView>

      {/* Thumbs down - animated visibility */}
      <AnimatedView style={[styles.thumbContainer, thumbsDownAnimatedStyle]}>
        <ActionButton
          onPress={handleDislike}
          icon={ThumbsDown}
          isActive={disliked}
          activeColor={primaryColor}
          iconColor={iconColor}
        />
      </AnimatedView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  button: {
    padding: 6,
    borderRadius: 6,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  thumbContainer: {
    overflow: 'hidden',
  },
});
