import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { useAuthContext } from '@/contexts/AuthContext';
import * as Haptics from 'expo-haptics';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface GreetingSuggestionsProps {
  onSuggestionClick: (suggestion: string) => void;
}

const SUGGESTIONS = [
  'Suggest a daily routine to wake up earlier',
  'Quiz me on capitals of U.S. states',
  'Give me 10 dinner ideas with eggs and rice',
];

export function GreetingSuggestions({ onSuggestionClick }: GreetingSuggestionsProps) {
  const { user } = useAuthContext();
  
  // Extract first name from user metadata or email
  const getUserFirstName = () => {
    if (!user) return null;
    
    const name = user.user_metadata?.full_name;
    if (name) {
      // Extract first name if full name is provided
      const firstName = name.split(' ')[0];
      return firstName;
    }
    
    // Fallback to email username
    if (user.email) {
      return user.email.split('@')[0];
    }
    
    return null;
  };

  const firstName = getUserFirstName();

  return (
    <View className="flex flex-col gap-6 items-start w-full px-4">
      {/* Header Section */}
      <View className="flex flex-col gap-2 items-start justify-center w-full px-4">
        <View className="flex flex-col justify-center w-full">
          <Text className="text-[36px] leading-[40px] font-medium text-foreground text-left">
            {firstName ? `Hi ${firstName},` : 'Hi there,'}
          </Text>
        </View>
        <View className="flex flex-col justify-center w-full opacity-50">
          <Text className="text-[36px] leading-[40px] font-medium text-foreground/60 text-left">
            Try These:
          </Text>
        </View>
      </View>

      {/* Suggestions Section */}
      <View className="flex flex-col gap-2 items-start justify-center w-full">
        {SUGGESTIONS.map((suggestion, index) => (
          <SuggestionButton
            key={index}
            suggestion={suggestion}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onSuggestionClick(suggestion);
            }}
          />
        ))}
      </View>
    </View>
  );
}

interface SuggestionButtonProps {
  suggestion: string;
  onPress: () => void;
}

function SuggestionButton({ suggestion, onPress }: SuggestionButtonProps) {
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="border border-border dark:border-border/80 rounded-full h-12 px-2 flex flex-row items-center justify-start active:opacity-80 max-w-full"
    >
      <View className="flex flex-row items-center justify-start px-2 flex-shrink">
        <Text 
          className="text-base font-medium text-foreground"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {suggestion}
        </Text>
      </View>
    </AnimatedPressable>
  );
}

