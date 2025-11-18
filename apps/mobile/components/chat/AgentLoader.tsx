import React, { useState, useEffect } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withRepeat,
  withTiming,
  Easing
} from 'react-native-reanimated';

const TEXTS = ["Thinking", "Planning", "Strategising", "Analyzing", "Processing"];
const TYPE_DELAY = 100;
const ERASE_DELAY = 50;
const PAUSE_DELAY = 1000;

const BlinkingCursor = () => {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0, { duration: 500, easing: Easing.ease }),
      -1,
      true
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.Text style={animatedStyle} className="text-xs text-muted-foreground">
      |
    </Animated.Text>
  );
};

export const AgentLoader = React.memo(function AgentLoader() {
  const [displayText, setDisplayText] = useState("");

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    let currentTextIndex = 0;
    let currentCharIndex = 0;

    const type = () => {
      const currentText = TEXTS[currentTextIndex];
      if (currentCharIndex < currentText.length) {
        setDisplayText(currentText.slice(0, currentCharIndex + 1));
        currentCharIndex++;
        timeoutId = setTimeout(type, TYPE_DELAY);
      } else {
        timeoutId = setTimeout(() => {
          currentCharIndex = currentText.length;
          erase();
        }, PAUSE_DELAY);
      }
    };

    const erase = () => {
      const currentText = TEXTS[currentTextIndex];
      if (currentCharIndex > 0) {
        currentCharIndex--;
        setDisplayText(currentText.slice(0, currentCharIndex));
        timeoutId = setTimeout(erase, ERASE_DELAY);
      } else {
        currentTextIndex = (currentTextIndex + 1) % TEXTS.length;
        currentCharIndex = 0;
        timeoutId = setTimeout(type, TYPE_DELAY);
      }
    };

    type();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  return (
    <View className="flex-row py-2 items-center w-full">
      <Text className="text-xs text-muted-foreground">
        {displayText}
      </Text>
      <BlinkingCursor />
    </View>
  );
});
