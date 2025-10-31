import React, { useState, useEffect } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
  Easing,
  FadeIn,
  FadeOut
} from 'react-native-reanimated';
import { KortixLoader } from '../ui';

const loadingMessages = [
  "Initializing neural pathways...",
  "Analyzing query complexity...",
  "Assembling cognitive framework...",
  "Orchestrating thought processes...",
  "Synthesizing contextual understanding...",
  "Calibrating response parameters...",
  "Engaging reasoning algorithms...",
  "Processing semantic structures...",
  "Formulating strategic approach...",
  "Optimizing solution pathways...",
  "Harmonizing data streams...",
  "Architecting intelligent response...",
  "Fine-tuning cognitive models...",
  "Weaving narrative threads...",
  "Crystallizing insights...",
  "Preparing comprehensive analysis..."
];

const PulsingDot = ({ delay = 0 }: { delay?: number }) => {
  const opacity = useSharedValue(0.4);

  useEffect(() => {
    opacity.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 500, easing: Easing.ease }),
          withTiming(0.4, { duration: 500, easing: Easing.ease })
        ),
        -1,
        false
      )
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View 
      style={animatedStyle} 
      className="h-1 w-1 rounded-full bg-primary"
    />
  );
};

export const AgentLoader = React.memo(function AgentLoader() {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setMessageIndex((prev) => (prev + 1) % loadingMessages.length);
    }, 1500);

    return () => clearInterval(interval);
  }, []);

  return (
    <View className="flex-row py-2 items-center gap-3 w-full">
      <View className="flex-row items-center gap-1">
        <KortixLoader size="small" />
      </View>
      <View className="flex-1">
        <Animated.View
          key={messageIndex}
          entering={FadeIn.duration(300).easing(Easing.ease)}
          exiting={FadeOut.duration(300).easing(Easing.ease)}
        >
          <Text className="text-xs text-muted-foreground">
            {loadingMessages[messageIndex]}
          </Text>
        </Animated.View>
      </View>
    </View>
  );
});
