import React, { useState, useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/text';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withDelay,
  withSequence,
  Easing,
  interpolate,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import { useColorScheme } from 'nativewind';

const thinkingPhrases = [
  'Brewing ideas',
  'Connecting the dots',
  'Cooking up',
  'Almost there',
  'Spinning up neurons',
  'Piecing it together',
  'Working some magic',
  'Crunching thoughts',
];

const BouncyDot = ({ delay }: { delay: number }) => {
  const translateY = useSharedValue(0);
  const opacity = useSharedValue(0.4);

  useEffect(() => {
    translateY.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(-4, { duration: 400, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 400, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        false
      )
    );
    opacity.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 400, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.4, { duration: 400, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        false
      )
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  return <Animated.View className="w-1 h-1 rounded-full bg-muted-foreground" style={animatedStyle} />;
};

const ShimmerText = ({ text }: { text: string }) => {
  const shimmerPosition = useSharedValue(0);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  useEffect(() => {
    shimmerPosition.value = withRepeat(
      withTiming(1, { duration: 1500, easing: Easing.linear }),
      -1,
      false
    );
  }, []);

  const animatedGradientStyle = useAnimatedStyle(() => {
    const translateX = interpolate(shimmerPosition.value, [0, 1], [-200, 200]);
    return {
      transform: [{ translateX }],
    };
  });

  const textColor = isDark ? '#a1a1aa' : '#71717a';
  const shimmerColor = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.7)';

  return (
    <MaskedView
      maskElement={
        <Text className="text-sm font-roobert-regular" style={{ color: '#000' }}>{text}</Text>
      }
    >
      <View style={{ width: 160, height: 18 }}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: textColor }]} />
        <Animated.View style={[StyleSheet.absoluteFill, { width: 200 }, animatedGradientStyle]}>
          <LinearGradient
            colors={[textColor, shimmerColor, textColor]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={{ flex: 1, width: 200 }}
          />
        </Animated.View>
      </View>
    </MaskedView>
  );
};

interface AgentLoaderProps {
  isReconnecting?: boolean;
  retryCount?: number;
}

export const AgentLoader = React.memo(function AgentLoader({ 
  isReconnecting = false, 
  retryCount = 0 
}: AgentLoaderProps) {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const textOpacity = useSharedValue(1);
  const textTranslateY = useSharedValue(0);

  useEffect(() => {
    // Don't cycle phrases when reconnecting
    if (isReconnecting) return;
    
    const interval = setInterval(() => {
      textOpacity.value = withTiming(0, { duration: 200, easing: Easing.ease });
      textTranslateY.value = withTiming(-4, { duration: 200, easing: Easing.ease });

      setTimeout(() => {
        setPhraseIndex((prev) => (prev + 1) % thinkingPhrases.length);
        textTranslateY.value = 4;
        textOpacity.value = 0;

        textOpacity.value = withTiming(1, { duration: 200, easing: Easing.ease });
        textTranslateY.value = withTiming(0, { duration: 200, easing: Easing.ease });
      }, 200);
    }, 2800);

    return () => clearInterval(interval);
  }, [isReconnecting]);

  const textAnimatedStyle = useAnimatedStyle(() => ({
    opacity: textOpacity.value,
    transform: [{ translateY: textTranslateY.value }],
  }));

  // Show reconnecting message when network issues detected
  const displayText = isReconnecting 
    ? `Reconnecting${retryCount > 0 ? ` (${retryCount}/5)` : ''}...`
    : thinkingPhrases[phraseIndex];

  return (
    <View className="flex-row items-center gap-2">
      <View className="flex-row items-center gap-1">
        <BouncyDot delay={0} />
        <BouncyDot delay={120} />
        <BouncyDot delay={240} />
      </View>

      <Animated.View style={textAnimatedStyle}>
        <ShimmerText text={displayText} />
      </Animated.View>
    </View>
  );
});
