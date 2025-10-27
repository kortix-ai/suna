import { AuthOverlay } from '@/components/AuthOverlay';
import { ChatContainer } from '@/components/ChatContainer';
import { ChatHeader } from '@/components/ChatHeader';
import { PanelContainer } from '@/components/PanelContainer';
import { Skeleton } from '@/components/Skeleton';
import { useAuth } from '@/hooks/useAuth';
import { useChatSession, useNewChatSession } from '@/hooks/useChatHooks';
import { useThemedStyles } from '@/hooks/useThemeColor';
import {
    useIsNewChatMode,
    useLeftPanelVisible,
    useRightPanelVisible,
    useSelectedProject,
    useSetLeftPanelVisible,
    useSetRightPanelVisible
} from '@/stores/ui-store';
import { View } from 'react-native';

export default function HomeScreen() {
    // Use store state instead of local state for panel visibility
    const leftPanelVisible = useLeftPanelVisible();
    const rightPanelVisible = useRightPanelVisible();
    const setLeftPanelVisible = useSetLeftPanelVisible();
    const setRightPanelVisible = useSetRightPanelVisible();

    const { user, loading } = useAuth();
    const selectedProject = useSelectedProject();
    const isNewChatMode = useIsNewChatMode();

    // Use appropriate chat session based on mode
    const projectChatSession = useChatSession(
        (!isNewChatMode && selectedProject?.id && selectedProject.id !== 'new-chat-temp')
            ? selectedProject.id
            : ''
    );
    const newChatSession = useNewChatSession();

    // Extract messages from both sessions
    const newChatMessages = newChatSession.messages;
    const projectMessages = projectChatSession.messages;

    // Select the right session based on mode
    const { messages } = isNewChatMode ? newChatSession : projectChatSession;

    // Simple fallback for tools panel - use newChatMessages OR messages
    const newchatmessages = (newChatMessages && newChatMessages.length > 0) ? newChatMessages : messages;

    // Basic logging to see which message state we have
    console.log('=== MESSAGE STATE DEBUG ===');
    console.log('isNewChatMode:', isNewChatMode);
    console.log('newChatMessages length:', newChatMessages?.length || 0);
    console.log('projectMessages length:', projectMessages?.length || 0);
    console.log('selected messages length:', messages?.length || 0);
    console.log('fallback newchatmessages length:', newchatmessages?.length || 0);
    console.log('=============================');

    const toggleLeftPanel = () => setLeftPanelVisible(!leftPanelVisible);
    const toggleRightPanel = () => setRightPanelVisible(!rightPanelVisible);

    const styles = useThemedStyles((theme) => ({
        container: {
            flex: 1,
            backgroundColor: theme.background,
        },
        header: {
            backgroundColor: theme.background,
            borderBottomWidth: 1,
            borderBottomColor: theme.border,
            justifyContent: 'center' as const,
        },
        chatContainer: {
            flex: 1,
        },
    }));

    if (loading) {
        return (
            <View style={styles.container}>
                <Skeleton />
            </View>
        );
    }

    if (!user) {
        return (
            <View style={styles.container}>
                <AuthOverlay
                    visible={true}
                    onClose={() => { }}
                />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <PanelContainer
                leftPanelVisible={leftPanelVisible}
                rightPanelVisible={rightPanelVisible}
                onCloseLeft={() => {
                    console.log('onCloseLeft called');
                    setLeftPanelVisible(false);
                }}
                onCloseRight={() => setRightPanelVisible(false)}
                onOpenLeft={() => setLeftPanelVisible(true)}
                messages={newchatmessages}
            >
                <View style={styles.header}>
                    <ChatHeader
                        onMenuPress={toggleLeftPanel}
                        onSettingsPress={toggleRightPanel}
                        selectedProject={selectedProject}
                    />
                </View>
                <View style={styles.chatContainer}>
                    <ChatContainer />
                </View>
            </PanelContainer>
        </View>
    );
} 