import { useTheme } from '@/hooks/useThemeColor';
import React, { useEffect } from 'react';
import { DimensionValue, View, ViewStyle } from 'react-native';
import Animated, {
    Easing,
    interpolate,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

interface SkeletonProps {
    width?: DimensionValue;
    height?: DimensionValue;
    borderRadius?: number;
    style?: ViewStyle;
}

export const Skeleton: React.FC<SkeletonProps> = ({
    width = '100%',
    height = 16,
    borderRadius = 4,
    style,
}) => {
    const theme = useTheme();
    const shimmerAnimation = useSharedValue(0);

    useEffect(() => {
        shimmerAnimation.value = withRepeat(
            withTiming(1, {
                duration: 1500,
                easing: Easing.ease,
            }),
            -1,
            false
        );
    }, []);

    const animatedStyle = useAnimatedStyle(() => {
        const opacity = interpolate(
            shimmerAnimation.value,
            [0, 0.5, 1],
            [0.3, 0.7, 0.3]
        );

        return {
            opacity,
        };
    });

    return (
        <View
            style={[
                {
                    width,
                    height,
                    borderRadius,
                    backgroundColor: theme.mutedWithOpacity(0.1),
                    overflow: 'hidden',
                },
                style,
            ]}
        >
            <Animated.View
                style={[
                    {
                        width: '100%',
                        height: '100%',
                        backgroundColor: theme.mutedWithOpacity(0.15),
                    },
                    animatedStyle,
                ]}
            />
        </View>
    );
};

// Preset skeleton components for common use cases
export const SkeletonText: React.FC<{ lines?: number; lastLineWidth?: DimensionValue }> = ({
    lines = 1,
    lastLineWidth = '75%',
}) => (
    <View>
        {Array.from({ length: lines }).map((_, index) => (
            <Skeleton
                key={index}
                height={16}
                width={index === lines - 1 ? lastLineWidth : '100%'}
                style={{ marginBottom: index < lines - 1 ? 8 : 0 }}
            />
        ))}
    </View>
);

export const SkeletonProject: React.FC = () => (
    <View style={{ paddingVertical: 10, borderRadius: 6, marginBottom: 4 }}>
        <Skeleton height={15} width="85%" />
    </View>
);

export const SkeletonProjects: React.FC<{ count?: number }> = ({ count = 3 }) => (
    <View>
        {Array.from({ length: count }).map((_, index) => (
            <SkeletonProject key={index} />
        ))}
    </View>
);

// Chat-specific skeletons that look like real messages
export const SkeletonChatMessage: React.FC<{
    isUser?: boolean;
    lines?: number;
    width?: number;
}> = ({
    isUser = false,
    lines = 2,
    width
}) => {
        const theme = useTheme();

        // Realistic width calculations based on typical message lengths
        const getUserMessageWidth = () => {
            if (width) return width;
            // User messages: 80-200px for short, 120-250px for longer
            return lines === 1 ? 80 + Math.random() * 120 : 120 + Math.random() * 130;
        };

        const getAIMessageWidth = (lineIndex: number, totalLines: number) => {
            if (lineIndex === totalLines - 1) {
                // Last line: shorter (100-180px)
                return 100 + Math.random() * 80;
            }
            // Other lines: longer (200-280px)
            return 200 + Math.random() * 80;
        };

        return (
            <View style={{
                marginVertical: 4,
                alignSelf: isUser ? 'flex-end' : 'flex-start',
                maxWidth: isUser ? '80%' : '100%',
            }}>
                {isUser ? (
                    // User message bubble style
                    <View style={{
                        backgroundColor: theme.mutedWithOpacity(0.1),
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        borderRadius: 16,
                        minWidth: 60,
                    }}>
                        <Skeleton
                            height={lines === 1 ? 20 : lines * 18}
                            width={getUserMessageWidth()}
                        />
                    </View>
                ) : (
                    // AI message full width style
                    <View style={{ paddingVertical: 8 }}>
                        {Array.from({ length: lines }).map((_, index) => (
                            <Skeleton
                                key={index}
                                height={20}
                                width={getAIMessageWidth(index, lines)}
                                style={{ marginBottom: index < lines - 1 ? 4 : 0 }}
                            />
                        ))}
                    </View>
                )}
            </View>
        );
    };

export const SkeletonChatMessages: React.FC = () => (
    <View style={{ padding: 16 }}>
        {/* User message - short */}
        <SkeletonChatMessage isUser={true} lines={1} width={90} />

        {/* AI response - multiple lines */}
        <SkeletonChatMessage isUser={false} lines={3} />

        {/* User message - longer */}
        <SkeletonChatMessage isUser={true} lines={1} width={180} />

        {/* AI response - shorter */}
        <SkeletonChatMessage isUser={false} lines={2} />

        {/* User message - medium */}
        <SkeletonChatMessage isUser={true} lines={1} width={140} />
    </View>
); 