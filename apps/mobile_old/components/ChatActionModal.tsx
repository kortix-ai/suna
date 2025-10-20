import { useThemedStyles } from '@/hooks/useThemeColor';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { Share2, Trash2 } from 'lucide-react-native';
import React, { useEffect } from 'react';
import {
    Dimensions,
    Modal,
    StyleSheet,
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

interface ChatActionModalProps {
    visible: boolean;
    onClose: () => void;
    chatName: string;
    onDelete: () => void;
    onShare: () => void;
    sourceLayout?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

export const ChatActionModal: React.FC<ChatActionModalProps> = ({
    visible,
    onClose,
    chatName,
    onDelete,
    onShare,
    sourceLayout,
}) => {
    const styles = useThemedStyles((theme) => ({
        overlay: {
            flex: 1,
        },
        backgroundContainer: {
            position: 'absolute' as const,
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1,
        },
        solidBackground: {
            position: 'absolute' as const,
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 2,
        },
        dismissArea: {
            position: 'absolute' as const,
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 3,
        },
        chatContainer: {
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderRadius: 8,
            backgroundColor: theme.sidebar,
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
        chatText: {
            fontSize: 15,
            lineHeight: 20,
            color: theme.foreground,
            fontWeight: '500' as const,
        },
        shareButton: {
            marginTop: 10,
            backgroundColor: theme.sidebar,
            borderRadius: 12,
            overflow: 'hidden' as const,
            shadowOffset: {
                width: 0,
                height: 4,
            },
            shadowOpacity: 0.3,
            shadowRadius: 8,
            elevation: 8,
            zIndex: 10,
        },
        shareButtonInner: {
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            justifyContent: 'center' as const,
            paddingHorizontal: 20,
            paddingVertical: 12,
        },
        shareText: {
            marginLeft: 8,
            fontSize: 15,
            color: theme.primary,
            fontWeight: '600' as const,
        },
        deleteButton: {
            marginTop: 8,
            backgroundColor: theme.sidebar,
            borderRadius: 12,
            overflow: 'hidden' as const,
            shadowOffset: {
                width: 0,
                height: 4,
            },
            shadowOpacity: 0.3,
            shadowRadius: 8,
            elevation: 8,
            zIndex: 10,
        },
        deleteButtonInner: {
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            justifyContent: 'center' as const,
            paddingHorizontal: 20,
            paddingVertical: 12,
        },
        deleteText: {
            marginLeft: 8,
            fontSize: 15,
            color: theme.destructive,
            fontWeight: '600' as const,
        },
    }));

    // Animation values
    const progress = useSharedValue(0);
    const backgroundOpacity = useSharedValue(0);

    const getActionPositions = () => {
        if (!sourceLayout) {
            return {
                actionsX: screenWidth / 2 - 70,
                actionsY: screenHeight / 2 + 20,
                actionsWidth: 140,
                actionsBelow: true,
            };
        }

        const buttonWidth = 140;
        const screenPadding = 24; // Increased padding for safety
        const minLeftPosition = screenPadding;
        const maxRightPosition = screenWidth - buttonWidth - screenPadding;

        // Start by centering under the chat item
        let buttonX = sourceLayout.x + (sourceLayout.width - buttonWidth) / 2;

        // If chat is too far left, bias towards right side of screen
        if (sourceLayout.x < 100) {
            // For left-side chats, position more towards center-right
            buttonX = Math.max(sourceLayout.x + 20, screenWidth * 0.25);
        }

        // Ensure it never goes off-screen with stronger constraints
        buttonX = Math.max(minLeftPosition, Math.min(buttonX, maxRightPosition));

        // Final safety check - if still too close to left edge, push it right
        if (buttonX < 40) {
            buttonX = 40;
        }

        const actionsHeight = 120; // Increased height for two buttons
        const spaceBelow = screenHeight - (sourceLayout.y + sourceLayout.height + 20);
        const actionsBelow = spaceBelow > actionsHeight;

        const actionsY = actionsBelow
            ? sourceLayout.y + sourceLayout.height + 8
            : sourceLayout.y - actionsHeight - 8;

        return {
            actionsX: buttonX,
            actionsY,
            actionsWidth: buttonWidth,
            actionsBelow
        };
    };

    const { actionsX, actionsY, actionsWidth, actionsBelow } = getActionPositions();

    useEffect(() => {
        if (visible) {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            backgroundOpacity.value = withTiming(1, { duration: 200 });
            setTimeout(() => {
                progress.value = withSpring(1, { damping: 15, stiffness: 120 });
            }, 30);
        } else {
            progress.value = withSpring(0, { damping: 18, stiffness: 140 });
            setTimeout(() => {
                backgroundOpacity.value = withTiming(0, { duration: 150 });
            }, 100);
        }
    }, [visible]);

    // TRUE morphing with pure scale - animates FROM original position  
    const animatedChatStyle = useAnimatedStyle(() => {
        if (!sourceLayout) {
            const centerX = screenWidth / 2 - 80;
            const centerY = screenHeight / 2 - 20;
            return {
                position: 'absolute',
                left: centerX,
                top: centerY,
                width: 160,
                opacity: progress.value,
                transform: [{ scale: interpolate(progress.value, [0, 1], [0.9, 1.1]) }],
            };
        }

        // Smart positioning - if chat is too far left, move it slightly to the right
        let targetX = sourceLayout.x;
        const adjustY = -2;

        // If original chat is too far left, nudge it slightly right
        if (sourceLayout.x < 40) {
            // For very left chats, small rightward nudge
            targetX = sourceLayout.x + 8;
        } else if (sourceLayout.x < 80) {
            // For moderately left chats, tiny rightward adjustment
            targetX = sourceLayout.x + 4;
        } else {
            // For center/right chats, keep original position with small adjustment
            targetX = sourceLayout.x - 3;
        }

        return {
            position: 'absolute',
            left: interpolate(
                progress.value,
                [0, 1],
                [sourceLayout.x, targetX]
            ),
            top: interpolate(
                progress.value,
                [0, 1],
                [sourceLayout.y, sourceLayout.y + adjustY]
            ),
            width: sourceLayout.width,
            height: sourceLayout.height,
            opacity: 1,
            transform: [
                { scale: interpolate(progress.value, [0, 1], [1, 1.1]) }
            ],
        };
    });

    const animatedShareStyle = useAnimatedStyle(() => {
        return {
            position: 'absolute',
            left: actionsX,
            top: actionsY,
            width: actionsWidth,
            opacity: interpolate(progress.value, [0, 0.5, 1], [0, 0, 1]),
            transform: [
                { scale: interpolate(progress.value, [0, 0.5, 1], [0.9, 0.95, 1]) },
                {
                    translateY: interpolate(
                        progress.value,
                        [0, 0.5, 1],
                        [actionsBelow ? 10 : -10, actionsBelow ? 5 : -5, 0]
                    )
                },
            ],
            zIndex: 10,
        };
    });

    const animatedDeleteStyle = useAnimatedStyle(() => {
        return {
            position: 'absolute',
            left: actionsX,
            top: actionsY + 60, // Position below share button
            width: actionsWidth,
            opacity: interpolate(progress.value, [0, 0.5, 1], [0, 0, 1]),
            transform: [
                { scale: interpolate(progress.value, [0, 0.5, 1], [0.9, 0.95, 1]) },
                {
                    translateY: interpolate(
                        progress.value,
                        [0, 0.5, 1],
                        [actionsBelow ? 10 : -10, actionsBelow ? 5 : -5, 0]
                    )
                },
            ],
            zIndex: 10,
        };
    });

    const animatedBackgroundStyle = useAnimatedStyle(() => ({
        opacity: backgroundOpacity.value,
    }));

    const handleDelete = () => {
        runOnJS(onDelete)();
        // Don't call onClose() here - onDelete will handle closing the modal
    };

    const handleShare = () => {
        runOnJS(onShare)();
        // Don't call onClose() here - onShare will handle closing the modal
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

                {/* Focused chat item */}
                <Animated.View style={[styles.chatContainer, animatedChatStyle]}>
                    <Body style={styles.chatText}>
                        {chatName}
                    </Body>
                </Animated.View>

                {/* Share button */}
                <Animated.View style={[styles.shareButton, animatedShareStyle]}>
                    <TouchableOpacity
                        style={styles.shareButtonInner}
                        onPress={handleShare}
                        activeOpacity={0.8}
                    >
                        <Share2 size={16} color={styles.shareText.color} />
                        <Body style={styles.shareText}>Share</Body>
                    </TouchableOpacity>
                </Animated.View>

                {/* Delete button */}
                <Animated.View style={[styles.deleteButton, animatedDeleteStyle]}>
                    <TouchableOpacity
                        style={styles.deleteButtonInner}
                        onPress={handleDelete}
                        activeOpacity={0.8}
                    >
                        <Trash2 size={16} color={styles.deleteText.color} />
                        <Body style={styles.deleteText}>Delete</Body>
                    </TouchableOpacity>
                </Animated.View>
            </View>
        </Modal>
    );
}; 