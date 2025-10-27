import React, { useEffect, useRef } from 'react';
import { View, Animated } from 'react-native';
import { useColorScheme } from 'nativewind';

interface AnimatedChatContainerProps {
  children: React.ReactNode;
  isDrawerOpen: boolean;
}

export function AnimatedChatContainer({ 
  children, 
  isDrawerOpen 
}: AnimatedChatContainerProps) {
  const scaleValue = useRef(new Animated.Value(1)).current;
  const borderRadiusValue = useRef(new Animated.Value(0)).current;
  const { colorScheme } = useColorScheme();
  
  useEffect(() => {
    if (isDrawerOpen) {
      Animated.parallel([
        Animated.spring(scaleValue, {
          toValue: 0.92,
          friction: 8,
          tension: 65,
          useNativeDriver: true,
        }),
        Animated.spring(borderRadiusValue, {
          toValue: 24,
          friction: 8,
          tension: 65,
          useNativeDriver: false,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.spring(scaleValue, {
          toValue: 1,
          friction: 8,
          tension: 65,
          useNativeDriver: true,
        }),
        Animated.spring(borderRadiusValue, {
          toValue: 0,
          friction: 8,
          tension: 65,
          useNativeDriver: false,
        }),
      ]).start();
    }
  }, [isDrawerOpen, scaleValue, borderRadiusValue]);
  
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <Animated.View
        style={{
          flex: 1,
          transform: [{ scale: scaleValue }],
          borderRadius: borderRadiusValue,
          overflow: 'hidden',
          backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
        }}
      >
        {children}
      </Animated.View>
    </View>
  );
}

/**
 * Usage Example in your chat component:
 * 
 * function ChatScreen() {
 *   const [isToolDrawerOpen, setIsToolDrawerOpen] = useState(false);
 *   
 *   return (
 *     <AnimatedChatContainer isDrawerOpen={isToolDrawerOpen}>
 *       <YourChatContent />
 *       <ToolCallPanel 
 *         visible={showToolPanel}
 *         onAnimationStateChange={setIsToolDrawerOpen}
 *         // ... other props
 *       />
 *     </AnimatedChatContainer>
 *   );
 * }
 */
