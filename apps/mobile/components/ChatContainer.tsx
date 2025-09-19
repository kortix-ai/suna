import { commonStyles } from '@/constants/CommonStyles';
import { useChatSession, useNewChatSession } from '@/hooks/useChatHooks';
import { useThemedStyles } from '@/hooks/useThemeColor';
import { useIsNewChatMode, useSelectedProject } from '@/stores/ui-store';
import { UploadedFile } from '@/utils/file-upload';
import React, { useEffect, useState } from 'react';
import { Keyboard, KeyboardEvent, Platform, View } from 'react-native';
import { ChatInput } from './ChatInput';
import { MessageThread } from './MessageThread';
import { SkeletonText } from './Skeleton';
import { Body } from './Typography';

interface ChatContainerProps {
    className?: string;
}

export const ChatContainer: React.FC<ChatContainerProps> = ({ className }) => {
    const selectedProject = useSelectedProject();
    const isNewChatMode = useIsNewChatMode();
    const [isAtBottomOfChat, setIsAtBottomOfChat] = useState(true);
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    // Use appropriate chat session based on mode
    const projectChatSession = useChatSession(
        (!isNewChatMode && selectedProject?.id && selectedProject.id !== 'new-chat-temp')
            ? selectedProject.id
            : ''
    );
    const newChatSession = useNewChatSession();

    // Select the right session based on mode
    const chatSession = isNewChatMode ? newChatSession : projectChatSession;

    const {
        messages,
        sendMessage,
        stopAgent,
        isGenerating,
        streamContent,
        streamError,
    } = chatSession;

    // For project mode, we still need these specific loading states
    const { isLoadingThread, isLoadingMessages, isSending: projectIsSending } = isNewChatMode ?
        { isLoadingThread: false, isLoadingMessages: false, isSending: false } :
        projectChatSession;

    // Get the correct isSending state based on mode
    const isSending = isNewChatMode ? (newChatSession.isSending || false) : projectIsSending;

    // Track keyboard height for MessageThread padding
    useEffect(() => {
        const handleKeyboardShow = (event: KeyboardEvent) => {
            setKeyboardHeight(event.endCoordinates.height);
        };

        const handleKeyboardHide = () => {
            setKeyboardHeight(0);
        };

        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

        const showSubscription = Keyboard.addListener(showEvent, handleKeyboardShow);
        const hideSubscription = Keyboard.addListener(hideEvent, handleKeyboardHide);

        return () => {
            showSubscription.remove();
            hideSubscription.remove();
        };
    }, []);

    const styles = useThemedStyles((theme) => ({
        container: {
            flex: 1,
            backgroundColor: theme.background,
        },
        loadingContainer: {
            ...commonStyles.flexCenter,
            backgroundColor: theme.background,
            paddingHorizontal: 32,
        },
        emptyContainer: {
            ...commonStyles.flexCenter,
            backgroundColor: theme.background,
            paddingHorizontal: 32,
        },
        emptyText: {
            color: theme.mutedForeground,
            fontSize: 18,
            textAlign: 'center' as const,
            lineHeight: 24,
        },
        emptySubtext: {
            color: theme.mutedForeground,
            fontSize: 14,
            textAlign: 'center' as const,
            marginTop: 8,
            opacity: 0.7,
        },
        chatContent: {
            flex: 1,
        },
    }));

    const handleScrollPositionChange = (isAtBottom: boolean) => {
        setIsAtBottomOfChat(isAtBottom);
    };

    // Show loading state while thread is being fetched (NOT created) - only for project mode
    if (!isNewChatMode && selectedProject && isLoadingThread) {
        return (
            <View style={styles.loadingContainer}>
                <SkeletonText lines={3} />
            </View>
        );
    }

    // Show empty state when no project is selected - ONLY in project mode
    if (!isNewChatMode && !selectedProject) {
        return (
            <View style={styles.emptyContainer}>
                <Body style={styles.emptyText}>Select a project to start chatting</Body>
                <Body style={styles.emptySubtext}>
                    Choose a project from the sidebar to begin your conversation.
                </Body>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.chatContent}>
                <MessageThread
                    messages={messages}
                    isGenerating={isGenerating}
                    isSending={isSending}
                    streamContent={streamContent}
                    streamError={streamError}
                    isLoadingMessages={isLoadingMessages}
                    onScrollPositionChange={handleScrollPositionChange}
                    keyboardHeight={keyboardHeight}
                    sandboxId={selectedProject?.sandbox?.id}
                />
            </View>
            <ChatInput
                onSendMessage={(content: string, files?: UploadedFile[]) => {
                    console.log('[ChatContainer] Sending message with files:', files?.length || 0);

                    if (isNewChatMode) {
                        // For new chat mode, pass files to the sendMessage function
                        (newChatSession.sendMessage as any)(content, files);
                    } else {
                        // For existing chat mode, files are already uploaded to sandbox
                        sendMessage(content);
                    }
                }}
                onCancelStream={stopAgent}
                placeholder={
                    isGenerating
                        ? "AI is responding..."
                        : isSending
                            ? "Sending..."
                            : isNewChatMode
                                ? "Start a new conversation..."
                                : `Chat with ${selectedProject?.name || 'project'}...`
                }
                isAtBottomOfChat={isAtBottomOfChat}
                isGenerating={isGenerating}
                isSending={isSending}
            />
        </View>
    );
}; 