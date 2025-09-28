import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import React, { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Dimensions,
    ScrollView,
    StyleSheet,
    TouchableOpacity,
    View
} from 'react-native';
import { PinchGestureHandler, PinchGestureHandlerGestureEvent } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedGestureHandler, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useImageContent } from '../../hooks/useImageContent';
import { useTheme } from '../../hooks/useThemeColor';
import { Body, Caption } from '../Typography';
import { ToolViewProps } from './ToolViewRegistry';

interface SeeImageToolViewProps extends ToolViewProps {
    assistantContent?: string;
    toolContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
    sandboxId?: string;
}

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

const extractSeeImageData = (toolCall?: any, toolContent?: string) => {
    let filePath = '';
    let description = '';
    let output = '';
    let isSuccess = true;
    let errorMessage = '';

    // Extract from tool call parameters
    if (toolCall?.parameters) {
        filePath = toolCall.parameters.file_path ||
            toolCall.parameters.image_path ||
            toolCall.parameters.path || '';
        description = toolCall.parameters.description || '';
    }

    // Parse tool content if available
    if (toolContent) {
        try {
            const parsed = JSON.parse(toolContent);

            if (parsed.tool_execution) {
                const toolExecution = parsed.tool_execution;

                // Extract arguments
                if (toolExecution.arguments) {
                    filePath = toolExecution.arguments.file_path ||
                        toolExecution.arguments.image_path ||
                        toolExecution.arguments.path || filePath;
                    description = toolExecution.arguments.description || description;
                }

                // Extract result
                if (toolExecution.result) {
                    const result = toolExecution.result;

                    if (result.success !== undefined) {
                        isSuccess = result.success;
                    }

                    if (result.error) {
                        errorMessage = result.error;
                        isSuccess = false;
                    }

                    if (result.output) {
                        output = result.output;
                    }

                    // Sometimes the file path is in the result
                    if (result.file_path) {
                        filePath = result.file_path;
                    }
                }
            }
        } catch (error) {
            console.error('Error parsing tool content:', error);
        }
    }

    return {
        filePath,
        description,
        output,
        isSuccess,
        errorMessage
    };
};

export const SeeImageToolView: React.FC<SeeImageToolViewProps> = ({
    toolCall,
    toolContent,
    isStreaming = false,
    isSuccess = true,
    sandboxId,
    ...props
}) => {
    const theme = useTheme();
    const [zoomLevel, setZoomLevel] = useState(1);
    const [progress, setProgress] = useState(0);

    // Animated values for pinch gesture
    const scale = useSharedValue(1);
    const baseScale = useSharedValue(1);

    const scrollViewRef = useRef<ScrollView>(null);

    const {
        filePath,
        description,
        output,
        isSuccess: actualIsSuccess,
        errorMessage
    } = extractSeeImageData(toolCall, toolContent);

    // Use the existing image loading infrastructure with the correct sandboxId
    const {
        data: imageUrl,
        isLoading: imageLoading,
        error: imageError,
        isProcessing
    } = useImageContent(
        sandboxId,
        filePath
    );

    const filename = filePath.split('/').pop() || filePath;
    const fileExt = filename.split('.').pop()?.toUpperCase() || '';

    console.log(`[SeeImageToolView] ${filePath} - sandboxId: ${sandboxId || 'none'}, imageUrl: ${imageUrl ? 'present' : 'none'}, loading: ${imageLoading}, zoom: ${zoomLevel}`);

    // Aggressively reset zoom when component mounts/unmounts or when switching images
    useEffect(() => {
        setZoomLevel(1);
        scale.value = 1;
        baseScale.value = 1;
        return () => {
            setZoomLevel(1);
            scale.value = 1;
            baseScale.value = 1;
        };
    }, [filePath]);

    useEffect(() => {
        if (isStreaming) {
            const timer = setInterval(() => {
                setProgress((prev) => {
                    if (prev >= 95) {
                        clearInterval(timer);
                        return prev;
                    }
                    return prev + 5;
                });
            }, 300);
            return () => clearInterval(timer);
        } else {
            setProgress(100);
        }
    }, [isStreaming]);

    const handleZoomIn = () => {
        const newZoom = Math.min(zoomLevel + 0.25, 3);
        setZoomLevel(newZoom);
        scale.value = withSpring(newZoom);
        baseScale.value = newZoom;
    };

    const handleZoomOut = () => {
        const newZoom = Math.max(zoomLevel - 0.25, 0.5);
        setZoomLevel(newZoom);
        scale.value = withSpring(newZoom);
        baseScale.value = newZoom;
    };



    const handleImagePress = () => {
        Alert.alert(
            'Image Options',
            'What would you like to do?',
            [
                {
                    text: 'Reset Zoom', onPress: () => {
                        setZoomLevel(1);
                        scale.value = withSpring(1);
                        baseScale.value = 1;
                    }
                },
                { text: 'Cancel', style: 'cancel' }
            ]
        );
    };

    // Pinch gesture handler
    const pinchGestureHandler = useAnimatedGestureHandler<PinchGestureHandlerGestureEvent, { startScale: number }>({
        onStart: (_, context) => {
            context.startScale = scale.value;
        },
        onActive: (event, context) => {
            const newScale = Math.min(Math.max(context.startScale * event.scale, 0.5), 3);
            scale.value = newScale;
        },
        onEnd: () => {
            baseScale.value = scale.value;
            // Update React state for button display
            runOnJS(setZoomLevel)(scale.value);
        }
    });

    // Animated style for the image wrapper
    const animatedStyle = useAnimatedStyle(() => {
        return {
            transform: [{ scale: scale.value }]
        };
    });

    const styles = StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: theme.background,
            transform: [{ scale: 1 }],
        },
        loadingContainer: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20,
        },
        progressContainer: {
            alignItems: 'center',
            marginTop: 20,
        },
        progressBar: {
            height: 4,
            backgroundColor: theme.muted,
            borderRadius: 2,
            overflow: 'hidden',
            width: 200,
        },
        progressFill: {
            height: '100%',
            backgroundColor: theme.primary,
            borderRadius: 2,
        },
        contentContainer: {
            flex: 1,
            transform: [{ scale: 1 }],
        },
        imageScrollContainer: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
        },
        imageContainer: {
            justifyContent: 'center',
            alignItems: 'center',
            padding: 16,
            overflow: 'hidden',
            width: screenWidth,
            height: screenHeight * 0.7,
        },
        pinchContainer: {
            overflow: 'hidden',
            width: screenWidth - 32,
            height: screenHeight * 0.6,
            justifyContent: 'center',
            alignItems: 'center',
        },
        imageWrapper: {
            overflow: 'hidden',
            borderRadius: 8,
            width: screenWidth - 32,
            height: screenHeight * 0.6,
            justifyContent: 'center',
            alignItems: 'center',
        },
        image: {
            width: screenWidth - 32,
            height: screenHeight * 0.6,
            borderRadius: 8,
        },
        errorContainer: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 40,
        },
        errorIcon: {
            marginBottom: 16,
        },
        controlsContainer: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderTopWidth: 1,
            borderTopColor: theme.border,
            backgroundColor: theme.background,
            transform: [{ scale: 1 }],
        },
        fileInfo: {
            flexDirection: 'row',
            alignItems: 'center',
        },
        fileTypeChip: {
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 12,
            backgroundColor: theme.secondary + '20',
            marginRight: 8,
        },
        zoomControls: {
            flexDirection: 'row',
            alignItems: 'center',
        },
        zoomButton: {
            padding: 8,
            borderRadius: 8,
            backgroundColor: theme.secondary,
            marginHorizontal: 4,
        },
        zoomText: {
            fontSize: 12,
            color: theme.foreground,
            minWidth: 40,
            textAlign: 'center',
        },
        disabledButton: {
            opacity: 0.5,
        },
    });

    if (!filePath) {
        return (
            <View style={styles.errorContainer}>
                <Ionicons
                    name="image-outline"
                    size={48}
                    color={theme.mutedForeground}
                    style={styles.errorIcon}
                />
                <Body style={{ color: theme.foreground, textAlign: 'center' }}>
                    No image path provided
                </Body>
            </View>
        );
    }

    if (isStreaming) {
        return (
            <View style={styles.loadingContainer}>
                <Ionicons
                    name="image-outline"
                    size={48}
                    color={theme.secondary}
                    style={styles.errorIcon}
                />
                <ActivityIndicator size="large" color={theme.secondary} />
                <Body style={{ marginTop: 16, textAlign: 'center', color: theme.foreground }}>
                    Loading image...
                </Body>
                <View style={styles.progressContainer}>
                    <View style={styles.progressBar}>
                        <View
                            style={[
                                styles.progressFill,
                                { width: `${progress}%` }
                            ]}
                        />
                    </View>
                    <Caption style={{ marginTop: 8, color: theme.mutedForeground }}>
                        {progress}%
                    </Caption>
                </View>
            </View>
        );
    }

    // Loading state - show when image is loading and we don't have cached data
    if (imageLoading && !imageUrl) {
        return (
            <View style={styles.loadingContainer}>
                <Ionicons
                    name="image-outline"
                    size={48}
                    color={theme.secondary}
                    style={styles.errorIcon}
                />
                <ActivityIndicator size="large" color={theme.secondary} />
                <Body style={{ marginTop: 16, textAlign: 'center', color: theme.foreground }}>
                    Loading image...
                </Body>
                {isProcessing && (
                    <Caption style={{ marginTop: 8, color: theme.mutedForeground }}>
                        Processing...
                    </Caption>
                )}
            </View>
        );
    }

    // Error state
    if (imageError && !isProcessing) {
        return (
            <View style={styles.errorContainer}>
                <Ionicons
                    name="image-outline"
                    size={48}
                    color={theme.destructive}
                    style={styles.errorIcon}
                />
                <Body style={{ color: theme.destructive, textAlign: 'center', marginBottom: 8 }}>
                    Unable to load image
                </Body>
                <Caption style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                    {imageError.message || filePath}
                </Caption>
            </View>
        );
    }

    // Success state - show image if we have data
    if (imageUrl) {
        return (
            <View style={styles.container}>
                <ScrollView
                    style={styles.contentContainer}
                    contentContainerStyle={styles.imageScrollContainer}
                    showsVerticalScrollIndicator={false}
                    showsHorizontalScrollIndicator={false}
                >
                    <View style={styles.imageContainer}>
                        <PinchGestureHandler onGestureEvent={pinchGestureHandler}>
                            <Animated.View style={styles.pinchContainer}>
                                <TouchableOpacity onPress={handleImagePress} activeOpacity={0.9}>
                                    <Animated.View style={[styles.imageWrapper, animatedStyle]}>
                                        <Image
                                            source={{ uri: imageUrl }}
                                            style={styles.image}
                                            contentFit="contain"
                                            onLoad={() => {
                                                console.log(`[SeeImageToolView] Image loaded successfully - ${filename}`);
                                            }}
                                            onError={(error) => {
                                                console.log(`[SeeImageToolView] Image error - ${filename}:`, error);
                                            }}
                                        />
                                    </Animated.View>
                                </TouchableOpacity>
                            </Animated.View>
                        </PinchGestureHandler>
                    </View>
                </ScrollView>

                <View style={styles.controlsContainer}>
                    <View style={styles.fileInfo}>
                        <View style={styles.fileTypeChip}>
                            <Caption style={{ color: theme.secondary, fontWeight: '600' }}>
                                {fileExt || 'IMG'}
                            </Caption>
                        </View>
                        <Caption numberOfLines={1} style={{ maxWidth: 120, color: theme.foreground }}>
                            {filename}
                        </Caption>
                    </View>

                    <View style={styles.zoomControls}>
                        <TouchableOpacity
                            style={[
                                styles.zoomButton,
                                zoomLevel <= 0.5 && styles.disabledButton
                            ]}
                            onPress={handleZoomOut}
                            disabled={zoomLevel <= 0.5}
                        >
                            <Ionicons
                                name="remove"
                                size={16}
                                color={theme.background}
                            />
                        </TouchableOpacity>

                        <Caption style={styles.zoomText}>
                            {Math.round(zoomLevel * 100)}%
                        </Caption>

                        <TouchableOpacity
                            style={[
                                styles.zoomButton,
                                zoomLevel >= 3 && styles.disabledButton
                            ]}
                            onPress={handleZoomIn}
                            disabled={zoomLevel >= 3}
                        >
                            <Ionicons
                                name="add"
                                size={16}
                                color={theme.background}
                            />
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        );
    }

    // Fallback - should not reach here under normal circumstances
    return (
        <View style={styles.errorContainer}>
            <Ionicons
                name="image-outline"
                size={48}
                color={theme.mutedForeground}
                style={styles.errorIcon}
            />
            <Body style={{ color: theme.foreground, textAlign: 'center' }}>
                Loading...
            </Body>
        </View>
    );
}; 