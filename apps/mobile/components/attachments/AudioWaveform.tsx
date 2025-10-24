import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
  withSpring,
} from 'react-native-reanimated';

interface AudioWaveformProps {
  isRecording?: boolean;
  barCount?: number;
  audioLevel?: number; // 0-1 normalized audio level from recorder
}

/**
 * AudioWaveform Component
 * 
 * Displays an animated waveform visualization for audio recording.
 * Uses realistic audio-reactive animations that respond to actual recording.
 */
export function AudioWaveform({ 
  isRecording = false, 
  barCount = 40,
  audioLevel = 0.5
}: AudioWaveformProps) {
  const bars = Array.from({ length: barCount }, (_, i) => i);
  
  // Simulate varying audio levels across bars for more realistic effect
  const audioLevels = React.useMemo(() => {
    return bars.map((_, i) => {
      // Center bars get more energy, edges less
      const centerDistance = Math.abs(i - barCount / 2) / (barCount / 2);
      const baseLevelVariation = (1 - centerDistance * 0.6);
      return audioLevel * baseLevelVariation + Math.random() * 0.2;
    });
  }, [audioLevel, barCount]);

  return (
    <View className="flex-row items-center justify-center h-12 gap-1">
      {bars.map((index) => (
        <WaveformBar 
          key={index} 
          index={index} 
          isRecording={isRecording}
          totalBars={barCount}
          audioLevel={audioLevels[index]}
        />
      ))}
    </View>
  );
}

interface WaveformBarProps {
  index: number;
  isRecording: boolean;
  totalBars: number;
  audioLevel: number;
}

function WaveformBar({ index, isRecording, totalBars, audioLevel }: WaveformBarProps) {
  const height = useSharedValue(4);
  const opacity = useSharedValue(0.3);

  React.useEffect(() => {
    if (isRecording) {
      // Calculate target height based on audio level
      const minHeight = 4;
      const maxHeight = 40;
      const baseHeight = minHeight + (maxHeight - minHeight) * audioLevel;
      
      // Add some natural variation
      const variation = Math.random() * 8;
      
      // Animate to audio-driven height with realistic timing
      height.value = withRepeat(
        withSequence(
          withSpring(baseHeight + variation, {
            damping: 8,
            stiffness: 180,
            mass: 0.8,
          }),
          withSpring(baseHeight - variation, {
            damping: 8,
            stiffness: 180,
            mass: 0.8,
          })
        ),
        -1,
        false
      );

      opacity.value = withTiming(0.8 + audioLevel * 0.2, {
        duration: 150,
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
  }, [isRecording, index, totalBars, audioLevel]);

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

