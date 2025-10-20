import { Message } from '@/api/chat-api';
import { commonStyles } from '@/constants/CommonStyles';
import { fontWeights } from '@/constants/Fonts';
import { useFileBrowser } from '@/hooks/useFileBrowser';
import { useTheme } from '@/hooks/useThemeColor';
import { useOpenToolView } from '@/stores/ui-store';

import { parseFileAttachments } from '@/utils/file-parser';
import { Markdown } from '@/utils/markdown-renderer';
import { parseMessage, processStreamContent } from '@/utils/message-parser';
import { ChevronDown } from 'lucide-react-native';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Keyboard, StyleSheet, TouchableOpacity, TouchableWithoutFeedback, View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withSequence,
    withTiming
} from 'react-native-reanimated';
import { AttachmentGroup } from './AttachmentGroup';
import { MessageActionModal } from './MessageActionModal';
import { SkeletonChatMessages } from './Skeleton';
import { ToolCallRenderer } from './ToolCallRenderer';
import { Body } from './Typography';

interface MessageItemProps {
    message: Message;
    sandboxId?: string;
    onLongPress?: (messageText: string, layout: { x: number; y: number; width: number; height: number }, messageId: string) => void;
    onToolPress?: (toolCall: any, messageId: string) => void;
}

const MessageItem = memo<MessageItemProps>(({ message, sandboxId, onLongPress, onToolPress }) => {
    const theme = useTheme();
    const messageRef = useRef<View>(null);
    const { openFileBrowser } = useFileBrowser();

    const parsedMessage = useMemo(() => parseMessage(message), [message]);

    // Apply file parsing to the content
    const { attachments, cleanContent } = useMemo(() =>
        parseFileAttachments(parsedMessage.cleanContent, message.metadata?.cached_files),
        [parsedMessage.cleanContent, message.metadata?.cached_files]
    );

    // Extract ask tool content and attachments
    const askToolContent = useMemo(() => {
        if (!parsedMessage.hasTools) return null;

        const askTools = parsedMessage.toolCalls.filter(tool => tool.functionName === 'ask');
        if (askTools.length === 0) return null;

        // Handle the first ask tool (there should typically be only one)
        const askTool = askTools[0];
        const text = askTool.parameters?.text || '';
        const attachments = askTool.parameters?.attachments || '';

        // Parse attachments (could be comma-separated)
        const attachmentList = attachments ? attachments.split(',').map((a: string) => a.trim()).filter(Boolean) : [];

        return {
            text,
            attachments: attachmentList
        };
    }, [parsedMessage.toolCalls, parsedMessage.hasTools]);

    // Filter out ask tools from regular tool rendering
    const nonAskToolCalls = useMemo(() => {
        if (!parsedMessage.hasTools) return [];
        return parsedMessage.toolCalls.filter(tool => tool.functionName !== 'ask');
    }, [parsedMessage.toolCalls, parsedMessage.hasTools]);

    const handleLongPress = () => {
        if (messageRef.current) {
            messageRef.current.measure((x, y, width, height, pageX, pageY) => {
                onLongPress?.(cleanContent, { x: pageX, y: pageY, width, height }, message.message_id);
            });
        }
    };

    const handleFilePress = (filepath: string) => {
        console.log('File pressed:', filepath);
        // Open file browser to view the file
        if (sandboxId) {
            openFileBrowser(sandboxId, filepath);
        }
    };

    const isUser = message.type === 'user';

    if (isUser) {
        return (
            <View style={[styles.messageContainer, { alignSelf: 'flex-end' }]}>
                <TouchableOpacity
                    ref={messageRef}
                    onLongPress={handleLongPress}
                    delayLongPress={500}
                    activeOpacity={0.8}
                >
                    <Animated.View style={[styles.messageBubble, {
                        backgroundColor: theme.card,
                        borderColor: theme.border,
                    }]}>
                        <Body style={[styles.messageText, { color: theme.userMessage }]}>
                            {cleanContent}
                        </Body>

                        {attachments.length > 0 && (
                            <AttachmentGroup
                                attachments={attachments}
                                onFilePress={handleFilePress}
                                layout="grid"
                                showPreviews={true}
                                maxHeight={120}
                                sandboxId={sandboxId}
                            />
                        )}
                    </Animated.View>
                </TouchableOpacity>
            </View>
        );
    } else {
        return (
            <View style={styles.aiMessageContainer}>
                {cleanContent && (
                    <Markdown style={[styles.markdownContent]}>
                        {cleanContent}
                    </Markdown>
                )}

                {attachments.length > 0 && (
                    <AttachmentGroup
                        attachments={attachments}
                        onFilePress={handleFilePress}
                        layout="grid"
                        showPreviews={true}
                        sandboxId={sandboxId}
                    />
                )}

                {/* Ask tool content */}
                {askToolContent && (
                    <>
                        {askToolContent.text && (
                            <Markdown style={[styles.markdownContent]}>
                                {askToolContent.text}
                            </Markdown>
                        )}

                        {askToolContent.attachments.length > 0 && (
                            <AttachmentGroup
                                attachments={askToolContent.attachments}
                                onFilePress={handleFilePress}
                                layout="grid"
                                showPreviews={true}
                                sandboxId={sandboxId}
                            />
                        )}
                    </>
                )}

                {nonAskToolCalls.length > 0 && (
                    <ToolCallRenderer
                        toolCalls={nonAskToolCalls}
                        onToolPress={(toolCall) => {
                            onToolPress?.(toolCall, message.message_id);
                        }}
                    />
                )}
            </View>
        );
    }
});

MessageItem.displayName = 'MessageItem';

interface MessageThreadProps {
    messages: Message[];
    isGenerating?: boolean;
    isSending?: boolean;
    streamContent?: string;
    streamError?: string | null;
    isLoadingMessages?: boolean;
    onScrollPositionChange?: (isAtBottom: boolean) => void;
    keyboardHeight?: number;
    sandboxId?: string;
}

// EXACT FRONTEND PATTERN - Simple thinking animation
const ThinkingText = memo<{ children: string; color: string }>(({ children, color }) => {
    const opacity = useSharedValue(0.3);

    useEffect(() => {
        opacity.value = withRepeat(
            withSequence(
                withTiming(1, { duration: 800 }),
                withTiming(0.3, { duration: 800 })
            ),
            -1,
            false
        );
    }, [opacity]);

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
    }));

    return (
        <Animated.View style={animatedStyle}>
            <Body style={[styles.generatingText, { color }]}>
                {children}
            </Body>
        </Animated.View>
    );
});

ThinkingText.displayName = 'ThinkingText';

// Shimmer effect for tool name
const ShimmerText = memo<{ children: string; color: string }>(({ children, color }) => {
    const shimmerPosition = useSharedValue(-1);

    useEffect(() => {
        shimmerPosition.value = withRepeat(
            withTiming(1, { duration: 1500 }),
            -1,
            false
        );
    }, [shimmerPosition]);

    const animatedStyle = useAnimatedStyle(() => {
        const inputRange = [-1, 0, 1];
        const outputRange = [0.4, 1, 0.4];

        return {
            opacity: shimmerPosition.value >= -0.5 && shimmerPosition.value <= 0.5 ? 1 : 0.7,
        };
    });

    return (
        <Animated.View style={animatedStyle}>
            <Body style={[styles.toolIndicatorText, { color }]}>
                {children}
            </Body>
        </Animated.View>
    );
});

ShimmerText.displayName = 'ShimmerText';

export const MessageThread: React.FC<MessageThreadProps> = ({
    messages,
    isGenerating = false,
    isSending = false,
    streamContent = '',
    streamError,
    isLoadingMessages = false,
    onScrollPositionChange,
    keyboardHeight = 0,
    sandboxId,
}) => {
    const theme = useTheme();
    const openToolView = useOpenToolView();

    // Log sandboxId for debugging
    console.log(`[MessageThread] sandboxId: ${sandboxId || 'undefined'}`);
    const flatListRef = useRef<FlatList>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);

    // Modal state
    const [modalVisible, setModalVisible] = useState(false);
    const [selectedMessageText, setSelectedMessageText] = useState('');
    const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
    const [sourceLayout, setSourceLayout] = useState<{ x: number; y: number; width: number; height: number } | undefined>();


    // EXACT FRONTEND PATTERN - Simple message display
    const displayMessages = useMemo(() => {
        // Simple reverse for inverted list - no complex logic
        return messages.slice().reverse();
    }, [messages]);



    // EXACT FRONTEND PATTERN - Show streaming content as text
    const showStreamingText = isGenerating && streamContent;

    // Simple auto-scroll on content change
    const handleContentSizeChange = useCallback(() => {
        if ((isGenerating || isSending) && flatListRef.current) {
            flatListRef.current.scrollToOffset({ offset: 0, animated: true });
        }
    }, [isGenerating, isSending]);

    // Auto-scroll when generating starts
    useEffect(() => {
        if (isGenerating || isSending) {
            Keyboard.dismiss();
            setTimeout(() => {
                if (flatListRef.current) {
                    flatListRef.current.scrollToOffset({ offset: 0, animated: true });
                }
            }, 50);
        }
    }, [isGenerating, isSending]);

    // Keyboard handling
    useEffect(() => {
        if (keyboardHeight > 0 && flatListRef.current) {
            setTimeout(() => {
                flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
            }, 100);
        }
    }, [keyboardHeight]);

    const handleScroll = useCallback((event: any) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;

        // For inverted FlatList, we're at bottom when offset is near 0
        // But also check if content fits in container (no scrolling needed)
        const contentFitsInContainer = contentSize.height <= layoutMeasurement.height;
        const isScrolledToBottom = contentOffset.y <= 20 || contentFitsInContainer;

        if (isScrolledToBottom !== isAtBottom) {
            setIsAtBottom(isScrolledToBottom);
            onScrollPositionChange?.(isScrolledToBottom);
        }
    }, [isAtBottom, onScrollPositionChange]);

    const scrollToBottom = useCallback(() => {
        if (flatListRef.current) {
            flatListRef.current.scrollToOffset({ offset: 0, animated: true });
        }
    }, []);

    const handleLongPress = useCallback((messageText: string, layout: { x: number; y: number; width: number; height: number }, messageId: string) => {
        setSelectedMessageText(messageText);
        setSourceLayout(layout);
        setSelectedMessageId(messageId);
        setModalVisible(true);
    }, []);

    const handleCloseModal = useCallback(() => {
        setModalVisible(false);
        setSelectedMessageText('');
        setSourceLayout(undefined);
        setSelectedMessageId(null);
    }, []);

    const handleToolPress = useCallback((toolCall: any, messageId: string) => {
        openToolView(toolCall, messageId);
    }, [openToolView]);

    const renderMessage = ({ item }: { item: Message }) => {
        // Skip rendering pure tool result messages
        const parsed = parseMessage(item);
        if (parsed.isToolResultMessage && !parsed.cleanContent.trim()) {
            return null;
        }

        return (
            <MessageItem
                message={item}
                sandboxId={sandboxId}
                onLongPress={handleLongPress}
                onToolPress={handleToolPress}
            />
        );
    };

    const keyExtractor = (item: Message) => item.message_id;

    // EXACT FRONTEND PATTERN - Simple footer with partial tool recognition
    const renderFooter = () => {
        if (!isGenerating && !isSending) return null;

        if (streamError) {
            return (
                <View style={styles.errorContainer}>
                    <Body style={[styles.errorText, { color: theme.destructive }]}>
                        {streamError.includes('No response received')
                            ? 'Agent completed but no response was generated. Please try again.'
                            : `Error: ${streamError}`
                        }
                    </Body>
                </View>
            );
        }

        if (showStreamingText) {
            // Process streaming content for partial tool recognition
            const processedStream = processStreamContent(streamContent);
            const { cleanContent, currentToolName, isStreamingTool } = processedStream;

            return (
                <View style={styles.streamingContainer}>
                    {cleanContent && (
                        <Markdown style={[styles.markdownContent]}>
                            {cleanContent}
                        </Markdown>
                    )}

                    {isStreamingTool && currentToolName && currentToolName.length > 2 && !currentToolName.includes('<') && (
                        <View style={styles.toolIndicatorContainer}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Body style={[styles.toolIndicatorText, { color: theme.mutedForeground }]}>
                                    🔧{' '}
                                </Body>
                                <ShimmerText color={theme.mutedForeground}>
                                    {currentToolName}
                                </ShimmerText>
                            </View>
                        </View>
                    )}

                    <View style={styles.streamingIndicator}>
                        <Body style={[styles.streamingIndicatorText, { color: theme.mutedForeground }]}>
                            ●
                        </Body>
                    </View>
                </View>
            );
        }

        return (
            <View style={styles.thinkingContainer}>
                <ThinkingText color={theme.placeholderText}>
                    Suna is thinking...
                </ThinkingText>
            </View>
        );
    };

    if (isLoadingMessages && messages.length === 0) {
        return (
            <View style={[styles.container, { backgroundColor: theme.background }]}>
                <SkeletonChatMessages />
            </View>
        );
    }

    if (messages.length === 0 && !isGenerating && !isSending) {
        return (
            <TouchableWithoutFeedback onPress={() => Keyboard.dismiss()}>
                <View style={[styles.container, { backgroundColor: theme.background }]}>
                    <View style={styles.emptyContainer}>
                        <Body style={[styles.emptyText, { color: theme.mutedForeground }]}>
                            This is the beginning of your conversation.
                        </Body>
                        <Body style={[styles.emptyText, { color: theme.mutedForeground, fontSize: 14, marginTop: 8, opacity: 0.7 }]}>
                            Send a message to get started!
                        </Body>
                    </View>
                </View>
            </TouchableWithoutFeedback>
        );
    }

    return (
        <>
            <FlatList
                ref={flatListRef}
                data={displayMessages}
                renderItem={renderMessage}
                keyExtractor={keyExtractor}
                style={[styles.container, { backgroundColor: theme.background }]}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
                removeClippedSubviews
                maxToRenderPerBatch={10}
                windowSize={10}
                inverted={true}
                ListHeaderComponent={renderFooter}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                onContentSizeChange={handleContentSizeChange}
            />

            {!isAtBottom && (
                <TouchableOpacity
                    style={[styles.scrollToBottomButton, { backgroundColor: theme.background, borderColor: theme.border }]}
                    onPress={scrollToBottom}
                    activeOpacity={0.8}
                >
                    <ChevronDown size={20} color={theme.foreground} strokeWidth={2} />
                </TouchableOpacity>
            )}

            <MessageActionModal
                visible={modalVisible}
                onClose={handleCloseModal}
                messageText={selectedMessageText}
                sourceLayout={sourceLayout}
            />
        </>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        paddingBottom: 20,
    },
    content: {
        padding: 16,
        paddingBottom: 0,
        flexGrow: 1,
    },
    messageContainer: {
        marginVertical: 4,
        maxWidth: '85%',
    },
    messageBubble: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderRadius: 24,
        borderBottomRightRadius: 8,
        borderWidth: 1,
        overflow: 'hidden',
        ...commonStyles.shadow,
    },
    messageText: {
        lineHeight: 20,
    },
    aiMessageContainer: {
        marginVertical: 4,
        width: '100%',
    },
    streamingContainer: {
        paddingVertical: 8,
        width: '100%',
    },
    streamingIndicator: {
        paddingTop: 4,
        alignItems: 'flex-start',
    },
    streamingIndicatorText: {
        fontSize: 12,
        opacity: 0.7,
    },
    generatingText: {
        fontStyle: 'italic',
        fontSize: 15,
        fontFamily: fontWeights[500],
    },
    errorContainer: {
        paddingVertical: 12,
        paddingHorizontal: 16,
        ...commonStyles.centerContainer,
    },
    errorText: {
        fontSize: 14,
        textAlign: 'center',
    },
    emptyContainer: {
        ...commonStyles.flexCenter,
        paddingHorizontal: 32,
    },
    emptyText: {
        fontSize: 16,
        textAlign: 'center',
        fontStyle: 'italic',
    },
    thinkingContainer: {
        paddingTop: 16,
        paddingBottom: 12,
        paddingHorizontal: 0,
        alignItems: 'flex-start',
    },
    scrollToBottomButton: {
        position: 'absolute',
        bottom: 20,
        right: 20,
        width: 40,
        height: 40,
        borderRadius: 20,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        ...commonStyles.shadow,
    },
    markdownContent: {
        flex: 1,
    },
    toolIndicatorContainer: {
        paddingVertical: 4,
        alignItems: 'flex-start',
    },
    toolIndicatorText: {
        fontSize: 13,
        fontStyle: 'italic',
        opacity: 0.8,

    },
});