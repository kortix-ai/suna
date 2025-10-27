import React from 'react';
import Animated from 'react-native-reanimated';

interface KeyboardAvoidingContainerProps {
    children: React.ReactNode;
    style?: any;
}

export const KeyboardAvoidingContainer: React.FC<KeyboardAvoidingContainerProps> = ({
    children,
    style,
}) => {
    return (
        <Animated.View style={[{ flex: 1 }, style]}>
            {children}
        </Animated.View>
    );
}; 