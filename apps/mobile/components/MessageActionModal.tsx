import { useTheme } from '@/hooks/useThemeColor';
import { BlurView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import React, { useEffect } from 'react';
import {
    Alert,
    Dimensions,
    Modal,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import Animated, {
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { Body } from './Typography';

interface MessageActionModalProps {
    visible: boolean;
    onClose: () => void;
    messageText: string;
    sourceLayout?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

export const MessageActionModal: React.FC<MessageActionModalProps> = ({
    visible,
    onClose,
    messageText,
    sourceLayout,
}) => {
    const theme = useTheme();

    // Animation values
    const progress = useSharedValue(0);
    const backgroundOpacity = useSharedValue(0);

    // Calculate positions for actions
    const getActionPositions = () => {
        if (!sourceLayout) {
            return {
                actionsX: screenWidth / 2 - 70,
                actionsY: screenHeight / 2 + 20,
                actionsWidth: 140,
                actionsBelow: true,
            };
        }

        // Smart button sizing and positioning
        const buttonMinWidth = 120; // Minimum button width
        const buttonMaxWidth = 160; // Maximum button width
        const screenPadding = 20; // Padding from screen edges

        // Calculate optimal button width
        const optimalWidth = Math.max(buttonMinWidth, Math.min(buttonMaxWidth, sourceLayout.width * 0.9));

        // Smart positioning logic
        let buttonX;

        if (sourceLayout.width < buttonMinWidth) {
            // For very short messages, center the button on screen but bias towards message
            const messageCenter = sourceLayout.x + sourceLayout.width / 2;
            buttonX = messageCenter - optimalWidth / 2;

            // Ensure it doesn't go off screen
            buttonX = Math.max(screenPadding, Math.min(buttonX, screenWidth - optimalWidth - screenPadding));
        } else {
            // For normal/long messages, center under the message
            buttonX = sourceLayout.x + (sourceLayout.width - optimalWidth) / 2;

            // Ensure it doesn't go off screen edges
            buttonX = Math.max(screenPadding, Math.min(buttonX, screenWidth - optimalWidth - screenPadding));
        }

        // Check if we should put actions below or above
        const actionsHeight = 70; // Button height with margin
        const spaceBelow = screenHeight - (sourceLayout.y + sourceLayout.height + 20);
        const actionsBelow = spaceBelow > actionsHeight;

        const actionsY = actionsBelow
            ? sourceLayout.y + sourceLayout.height + 8
            : sourceLayout.y - actionsHeight - 8;

        return {
            actionsX: buttonX,
            actionsY,
            actionsWidth: optimalWidth,
            actionsBelow
        };
    };

    const { actionsX, actionsY, actionsWidth, actionsBelow } = getActionPositions();

    useEffect(() => {
        if (visible) {
            // Add haptic feedback when modal opens
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

            backgroundOpacity.value = withTiming(1, { duration: 200 });
            setTimeout(() => {
                progress.value = withSpring(1, { damping: 15, stiffness: 120 });
            }, 30);
        } else {
            // Ensure reverse morphing animation works on close
            progress.value = withSpring(0, { damping: 18, stiffness: 140 });
            setTimeout(() => {
                backgroundOpacity.value = withTiming(0, { duration: 150 });
            }, 100);
        }
    }, [visible]);

    // TRUE morphing with pure scale - animates FROM original position
    const animatedMessageStyle = useAnimatedStyle(() => {
        if (!sourceLayout) {
            const centerX = screenWidth / 2 - 160;
            const centerY = screenHeight / 2 - 80;
            return {
                position: 'absolute',
                left: interpolate(progress.value, [0, 1], [centerX + 50, centerX]),
                top: interpolate(progress.value, [0, 1], [centerY + 30, centerY]),
                width: 320,
                opacity: progress.value,
                transform: [{ scale: interpolate(progress.value, [0, 1], [0.9, 1.1]) }],
            };
        }

        // Morph from original position to slightly adjusted position with scale
        // This creates the morphing effect while maintaining same dimensions
        const adjustX = -5; // Slight leftward adjustment to center the scaled bubble
        const adjustY = -3; // Slight upward adjustment

        return {
            position: 'absolute',
            left: interpolate(
                progress.value,
                [0, 1],
                [sourceLayout.x, sourceLayout.x + adjustX]
            ),
            top: interpolate(
                progress.value,
                [0, 1],
                [sourceLayout.y, sourceLayout.y + adjustY]
            ),
            width: sourceLayout.width,
            height: sourceLayout.height,
            opacity: 1, // Always visible for true layoutId effect
            transform: [
                {
                    scale: interpolate(progress.value, [0, 1], [1, 1.1])
                }
            ],
        };
    });

    // Actions positioned based on space
    const animatedActionsStyle = useAnimatedStyle(() => {
        return {
            position: 'absolute',
            left: actionsX,
            top: actionsY,
            width: actionsWidth,
            opacity: interpolate(progress.value, [0, 0.5, 1], [0, 0, 1]),
            transform: [
                {
                    scale: interpolate(progress.value, [0, 0.5, 1], [0.9, 0.95, 1])
                },
                {
                    translateY: interpolate(
                        progress.value,
                        [0, 0.5, 1],
                        [actionsBelow ? 10 : -10, actionsBelow ? 5 : -5, 0]
                    )
                },
            ],
        };
    });

    const animatedBackgroundStyle = useAnimatedStyle(() => ({
        opacity: backgroundOpacity.value,
    }));

    const handleCopy = async () => {
        try {
            await Clipboard.setStringAsync(messageText);
            runOnJS(onClose)();
        } catch (error) {
            Alert.alert('Error', 'Failed to copy message');
        }
    };

    if (!visible) return null;

    return (
        <Modal
            transparent
            visible={visible}
            animationType="none"
            onRequestClose={onClose}
            statusBarTranslucent
        >
            <View style={styles.overlay}>
                {/* Background Layer 1: Blur */}
                <Animated.View style={[styles.backgroundContainer, animatedBackgroundStyle]}>
                    <BlurView
                        intensity={25}
                        style={StyleSheet.absoluteFillObject}
                        tint="dark"
                    />
                </Animated.View>

                {/* Background Layer 2: Solid overlay */}
                <Animated.View style={[
                    styles.solidBackground,
                    animatedBackgroundStyle,
                    { backgroundColor: 'rgba(0, 0, 0, 0.6)' }
                ]} />

                {/* Dismiss area */}
                <TouchableOpacity
                    style={styles.dismissArea}
                    activeOpacity={1}
                    onPress={onClose}
                />

                <Animated.View style={[
                    styles.messageContainer,
                    { backgroundColor: theme.sidebar },
                    animatedMessageStyle
                ]}>
                    <Body style={[styles.messageText, { color: theme.userMessage }]}>
                        {messageText}
                    </Body>
                </Animated.View>

                {/* Single Copy button - iOS style */}
                <Animated.View style={[
                    styles.copyButton,
                    {
                        backgroundColor: theme.sidebar,
                    },
                    animatedActionsStyle
                ]}>
                    <TouchableOpacity
                        style={styles.copyButtonInner}
                        onPress={handleCopy}
                        activeOpacity={0.8}
                    >
                        <Text style={[styles.copyText, { color: theme.foreground }]}>
                            Copy
                        </Text>
                    </TouchableOpacity>
                </Animated.View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
    },
    backgroundContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1,
    },
    solidBackground: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 2,
    },
    dismissArea: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 3,
    },
    messageContainer: {
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 16,
        shadowColor: '#000',
        shadowOffset: {
            width: 0,
            height: 6,
        },
        shadowOpacity: 0.25,
        shadowRadius: 12,
        elevation: 10,
        zIndex: 10,
    },
    messageText: {
        fontSize: 16,
        lineHeight: 22,
    },
    copyButton: {
        marginTop: 10,
        minWidth: 100,
        borderRadius: 14,
        overflow: 'hidden',
        shadowOffset: {
            width: 0,
            height: 4,
        },
        shadowOpacity: 0.3,
        opacity: 0.8,
        shadowRadius: 8,
        elevation: 8,
        zIndex: 10,
    },
    copyButtonInner: {
        paddingHorizontal: 24,
        paddingVertical: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    copyText: {
        fontSize: 16,
        fontWeight: '600',
        letterSpacing: 0.2,
    },
}); 