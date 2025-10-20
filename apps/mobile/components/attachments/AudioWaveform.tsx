import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from 'react-native-reanimated';

interface AudioWaveformProps {
  isRecording?: boolean;
  barCount?: number;
}

/**
 * AudioWaveform Component
 * 
 * Displays an animated waveform visualization for audio recording.
 * Bars animate with random heights to simulate audio input levels.
 */
export function AudioWaveform({ 
  isRecording = false, 
  barCount = 40 
}: AudioWaveformProps) {
  const bars = Array.from({ length: barCount }, (_, i) => i);

  return (
    <View className="flex-row items-center justify-center h-12 gap-1">
      {bars.map((index) => (
        <WaveformBar 
          key={index} 
          index={index} 
          isRecording={isRecording}
          totalBars={barCount}
        />
      ))}
    </View>
  );
}

interface WaveformBarProps {
  index: number;
  isRecording: boolean;
  totalBars: number;
}

function WaveformBar({ index, isRecording, totalBars }: WaveformBarProps) {
  const height = useSharedValue(4);
  const opacity = useSharedValue(0.3);

  React.useEffect(() => {
    if (isRecording) {
      // Stagger the animation start based on index for wave effect
      const delay = (index / totalBars) * 200;
      
      // Random height animation
      height.value = withRepeat(
        withSequence(
          withTiming(Math.random() * 32 + 8, {
            duration: 300 + Math.random() * 200,
            easing: Easing.inOut(Easing.ease),
          }),
          withTiming(Math.random() * 24 + 4, {
            duration: 300 + Math.random() * 200,
            easing: Easing.inOut(Easing.ease),
          })
        ),
        -1,
        false
      );

      opacity.value = withTiming(1, {
        duration: 200,
        easing: Easing.inOut(Easing.ease),
      });
    } else {
      height.value = withTiming(4, {
        duration: 200,
        easing: Easing.inOut(Easing.ease),
      });
      opacity.value = withTiming(0.3, {
        duration: 200,
        easing: Easing.inOut(Easing.ease),
      });
    }
  }, [isRecording, index, totalBars]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: height.value,
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      className="w-1 bg-primary rounded-full"
      style={animatedStyle}
    />
  );
}

