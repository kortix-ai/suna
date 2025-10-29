import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';

interface AudioWaveformProps {
  isRecording?: boolean;
  audioLevels?: number[]; // Time-series array of audio samples
}

/**
 * AudioWaveform Component
 * 
 * iOS-style vertical bar waveform that displays REAL audio data.
 * Each bar represents one time sample from the audio buffer.
 * Scrolls left as new audio comes in (oldest on left, newest on right).
 */
export function AudioWaveform({ 
  isRecording = false,
  audioLevels = []
}: AudioWaveformProps) {
  
  if (!isRecording) {
    return null;
  }

  return (
    <View className="flex-row items-center justify-center h-12 w-full gap-[2px] px-4">
      {audioLevels.map((level, index) => (
        <WaveformBar 
          key={index}
          audioLevel={level}
          isRecording={isRecording}
        />
      ))}
    </View>
  );
}

interface WaveformBarProps {
  audioLevel: number;
  isRecording: boolean;
}

function WaveformBar({ audioLevel, isRecording }: WaveformBarProps) {
  const height = useSharedValue(3);
  const opacity = useSharedValue(0.3);
  
  React.useEffect(() => {
    if (isRecording) {
      // Calculate height directly from audio level
      const minHeight = 2; // Lower base for less sensitive look
      const maxHeight = 44; // Slightly lower max
      const targetHeight = minHeight + (maxHeight - minHeight) * audioLevel;
      
      // FAST timing animation for instant response (not spring)
      height.value = withTiming(targetHeight, {
        duration: 40, // Even faster for instant feedback
        easing: Easing.out(Easing.ease),
      });
      
      // Opacity follows volume with more subtle range
      opacity.value = withTiming(0.5 + audioLevel * 0.5, {
        duration: 40,
        easing: Easing.out(Easing.ease),
      });
    } else {
      height.value = withTiming(2, {
        duration: 200,
        easing: Easing.inOut(Easing.ease),
      });
      opacity.value = withTiming(0.3, {
        duration: 200,
        easing: Easing.inOut(Easing.ease),
      });
    }
  }, [isRecording, audioLevel]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: height.value,
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      className="flex-1 bg-primary rounded-full"
      style={animatedStyle}
    />
  );
}
