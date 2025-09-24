import { fontWeights } from '@/constants/Fonts';
import { useAuth } from '@/hooks/useAuth';
import { useThemedStyles } from '@/hooks/useThemeColor';
import { useAgentSettingsStore } from '@/stores/agent-settings-store';
import {
    useAgentDetailsQuery,
    useAgentsQuery,
    useAvailableModelsQuery,
    useKnowledgeBaseQuery,
    useToggleKnowledgeEntryMutation,
    useToggleTriggerMutation,
    useTriggersQuery,
} from '@/hooks/useAgentSettings';
import { Check, X } from 'lucide-react-native';
import React, { useMemo } from 'react';
import { ActivityIndicator, Modal, Platform, ScrollView, Switch, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Body, Caption, H3, Label } from './Typography';

interface SettingsDrawerProps {
    visible: boolean;
    onClose: () => void;
}

export const SettingsDrawer: React.FC<SettingsDrawerProps> = ({ visible, onClose }) => {
    const insets = useSafeAreaInsets();
    const { signOut } = useAuth();
    const {
        selectedModel,
        selectedAgentId,
        selectedAgentName,
        setSelectedModel,
        setSelectedAgent,
    } = useAgentSettingsStore();

    const modelsQuery = useAvailableModelsQuery();
    const agentsQuery = useAgentsQuery(100);
    const agentDetailsQuery = useAgentDetailsQuery(selectedAgentId);
    const knowledgeBaseQuery = useKnowledgeBaseQuery(selectedAgentId);
    const triggersQuery = useTriggersQuery(selectedAgentId);

    const toggleKnowledgeMutation = useToggleKnowledgeEntryMutation(selectedAgentId);
    const toggleTriggerMutation = useToggleTriggerMutation(selectedAgentId);

    const integrations = useMemo(() => {
        const configured = agentDetailsQuery.data?.configured_mcps ?? [];
        const custom = agentDetailsQuery.data?.custom_mcps ?? [];
        return [
            ...configured.map((item) => ({ name: item.name ?? 'Integration', type: 'native' })),
            ...custom.map((item) => ({ name: item.name ?? 'Custom Integration', type: item.type ?? item.customType ?? 'custom' })),
        ];
    }, [agentDetailsQuery.data?.configured_mcps, agentDetailsQuery.data?.custom_mcps]);

    const styles = useThemedStyles((theme) => ({
        container: {
            flex: 1,
            backgroundColor: Platform.OS === 'android' ? 'rgba(0, 0, 0, 0.5)' : 'transparent',
            justifyContent: 'flex-end' as const,
        },
        drawer: {
            backgroundColor: theme.background,
            ...(Platform.OS === 'ios' ? { height: '100%' as const } : { height: '93%' as const }),
            borderTopLeftRadius: Platform.OS === 'android' ? 16 : 0,
            borderTopRightRadius: Platform.OS === 'android' ? 16 : 0,
            paddingTop: 20,
            paddingBottom: insets.bottom,
        },
        header: {
            flexDirection: 'row' as const,
            justifyContent: 'space-between' as const,
            alignItems: 'center' as const,
            paddingHorizontal: 20,
            paddingBottom: 20,
            borderBottomWidth: 1,
            borderBottomColor: theme.border,
        },
        title: {
            color: theme.foreground,
        },
        closeButton: {
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: theme.mutedWithOpacity(0.1),
            justifyContent: 'center' as const,
            alignItems: 'center' as const,
        },
        content: {
            flex: 1,
        },
        scrollContent: {
            paddingHorizontal: 20,
            paddingTop: 20,
            paddingBottom: 12,
            gap: 20,
        },
        section: {
            gap: 12,
        },
        sectionHeader: {
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            justifyContent: 'space-between' as const,
        },
        sectionTitle: {
            color: theme.foreground,
            fontFamily: fontWeights[600],
            fontSize: 16,
        },
        sectionSubtitle: {
            color: theme.mutedForeground,
        },
        optionList: {
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 12,
            overflow: 'hidden' as const,
        },
        optionRow: {
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            justifyContent: 'space-between' as const,
            paddingHorizontal: 16,
            paddingVertical: 14,
            backgroundColor: theme.background,
            borderBottomWidth: 1,
            borderBottomColor: theme.border,
        },
        optionRowLast: {
            borderBottomWidth: 0,
        },
        optionSelected: {
            backgroundColor: theme.mutedWithOpacity(0.12),
        },
        optionTitle: {
            color: theme.foreground,
        },
        optionDescription: {
            color: theme.mutedForeground,
            marginTop: 4,
        },
        markerSelected: {
            color: theme.primary,
        },
        emptyState: {
            padding: 16,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 12,
            backgroundColor: theme.mutedWithOpacity(0.05),
        },
        toggleRow: {
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            justifyContent: 'space-between' as const,
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 12,
            marginBottom: 12,
            backgroundColor: theme.background,
        },
        toggleText: {
            flex: 1,
            marginRight: 12,
        },
        badge: {
            marginTop: 6,
            alignSelf: 'flex-start' as const,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 10,
            backgroundColor: theme.mutedWithOpacity(0.15),
        },
        signOutButton: {
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderRadius: 8,
            backgroundColor: theme.mutedWithOpacity(0.1),
            marginTop: 'auto' as const,
            marginBottom: 20,
        },
        signOutText: {
            color: theme.destructive,
            fontSize: 15,
            fontFamily: fontWeights[500],
            textAlign: 'center' as const,
        },
    }));

    const handleSignOut = async () => {
        try {
            await signOut();
            onClose();
        } catch (error) {
            console.error('Error signing out:', error);
        }
    };

    return (
        <Modal
            visible={visible}
            transparent={Platform.OS === 'android'}
            animationType="slide"
            presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
            onRequestClose={onClose}
        >
            <View style={styles.container}>
                {Platform.OS === 'android' && (
                    <TouchableOpacity
                        style={{ flex: 1 }}
                        activeOpacity={1}
                        onPress={onClose}
                    />
                )}

                <View style={styles.drawer}>
                    <View style={styles.header}>
                        <H3 style={styles.title}>Settings</H3>
                        <TouchableOpacity style={styles.closeButton} onPress={onClose}>
                            <X size={18} color={styles.title.color} />
                        </TouchableOpacity>
                    </View>

                    <ScrollView
                        style={styles.content}
                        contentContainerStyle={styles.scrollContent}
                        showsVerticalScrollIndicator={false}
                    >
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Label style={styles.sectionTitle}>AI Model</Label>
                            </View>
                            {modelsQuery.isLoading ? (
                                <ActivityIndicator />
                            ) : modelsQuery.data?.models?.length ? (
                                <View style={styles.optionList}>
                                    {modelsQuery.data.models.map((model, index, array) => {
                                        const identifier = model.short_name || model.id;
                                        const isSelected = selectedModel === identifier;
                                        return (
                                            <TouchableOpacity
                                                key={identifier}
                                                style={[
                                                    styles.optionRow,
                                                    index === array.length - 1 ? styles.optionRowLast : null,
                                                    isSelected ? styles.optionSelected : null,
                                                ]}
                                                activeOpacity={0.8}
                                                onPress={() => setSelectedModel(identifier)}
                                            >
                                                <View style={{ flex: 1 }}>
                                                    <Body style={styles.optionTitle}>
                                                        {model.display_name || identifier}
                                                    </Body>
                                                    {model.requires_subscription ? (
                                                        <Caption style={styles.optionDescription}>Requires subscription</Caption>
                                                    ) : null}
                                                </View>
                                                {isSelected ? <Check size={18} color={styles.markerSelected.color} /> : null}
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                            ) : (
                                <View style={styles.emptyState}>
                                    <Caption style={styles.sectionSubtitle}>No models available</Caption>
                                </View>
                            )}
                        </View>

                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Label style={styles.sectionTitle}>Agent</Label>
                                {selectedAgentName ? (
                                    <Caption style={styles.sectionSubtitle}>{selectedAgentName}</Caption>
                                ) : null}
                            </View>
                            {agentsQuery.isLoading ? (
                                <ActivityIndicator />
                            ) : agentsQuery.data?.agents?.length ? (
                                <View style={styles.optionList}>
                                    {agentsQuery.data.agents.map((agent, index, array) => {
                                        const isSelected = selectedAgentId === agent.agent_id;
                                        return (
                                            <TouchableOpacity
                                                key={agent.agent_id}
                                                style={[
                                                    styles.optionRow,
                                                    index === array.length - 1 ? styles.optionRowLast : null,
                                                    isSelected ? styles.optionSelected : null,
                                                ]}
                                                activeOpacity={0.8}
                                                onPress={() => setSelectedAgent(agent.agent_id, agent.name)}
                                            >
                                                <View style={{ flex: 1 }}>
                                                    <Body style={styles.optionTitle}>{agent.name}</Body>
                                                    {agent.description ? (
                                                        <Caption style={styles.optionDescription}>{agent.description}</Caption>
                                                    ) : null}
                                                </View>
                                                {isSelected ? <Check size={18} color={styles.markerSelected.color} /> : null}
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                            ) : (
                                <View style={styles.emptyState}>
                                    <Caption style={styles.sectionSubtitle}>No agents available</Caption>
                                </View>
                            )}
                        </View>

                        <View style={styles.section}>
                            <Label style={styles.sectionTitle}>Integrations</Label>
                            {selectedAgentId ? (
                                agentDetailsQuery.isLoading ? (
                                    <ActivityIndicator />
                                ) : integrations.length ? (
                                    integrations.map((integration, index) => (
                                        <View key={`${integration.name}-${index}`} style={styles.toggleRow}>
                                            <View style={styles.toggleText}>
                                                <Body style={styles.optionTitle}>{integration.name}</Body>
                                                <Caption style={styles.optionDescription}>
                                                    {integration.type === 'native' ? 'Built-in integration' : 'Custom integration'}
                                                </Caption>
                                            </View>
                                        </View>
                                    ))
                                ) : (
                                    <View style={styles.emptyState}>
                                        <Caption style={styles.sectionSubtitle}>No integrations configured for this agent</Caption>
                                    </View>
                                )
                            ) : (
                                <Caption style={styles.sectionSubtitle}>Select an agent to view integrations</Caption>
                            )}
                        </View>

                        <View style={styles.section}>
                            <Label style={styles.sectionTitle}>Knowledge Base</Label>
                            {selectedAgentId ? (
                                knowledgeBaseQuery.isLoading ? (
                                    <ActivityIndicator />
                                ) : knowledgeBaseQuery.data?.entries?.length ? (
                                    knowledgeBaseQuery.data.entries.map((entry) => (
                                        <View key={entry.entry_id} style={styles.toggleRow}>
                                            <View style={styles.toggleText}>
                                                <Body style={styles.optionTitle}>{entry.name}</Body>
                                                {entry.description ? (
                                                    <Caption style={styles.optionDescription}>{entry.description}</Caption>
                                                ) : null}
                                                {entry.usage_context ? (
                                                    <Caption style={styles.badge}>{entry.usage_context}</Caption>
                                                ) : null}
                                            </View>
                                            <Switch
                                                value={entry.is_active}
                                                onValueChange={(value) =>
                                                    toggleKnowledgeMutation.mutate({ entryId: entry.entry_id, isActive: value })
                                                }
                                            />
                                        </View>
                                    ))
                                ) : (
                                    <View style={styles.emptyState}>
                                        <Caption style={styles.sectionSubtitle}>No knowledge entries for this agent yet</Caption>
                                    </View>
                                )
                            ) : (
                                <Caption style={styles.sectionSubtitle}>Select an agent to manage knowledge base entries</Caption>
                            )}
                        </View>

                        <View style={styles.section}>
                            <Label style={styles.sectionTitle}>Triggers</Label>
                            {selectedAgentId ? (
                                triggersQuery.isLoading ? (
                                    <ActivityIndicator />
                                ) : triggersQuery.data?.length ? (
                                    triggersQuery.data.map((trigger) => (
                                        <View key={trigger.trigger_id} style={styles.toggleRow}>
                                            <View style={styles.toggleText}>
                                                <Body style={styles.optionTitle}>{trigger.name}</Body>
                                                {trigger.description ? (
                                                    <Caption style={styles.optionDescription}>{trigger.description}</Caption>
                                                ) : null}
                                            </View>
                                            <Switch
                                                value={trigger.is_active}
                                                onValueChange={(value) =>
                                                    toggleTriggerMutation.mutate({ triggerId: trigger.trigger_id, isActive: value })
                                                }
                                            />
                                        </View>
                                    ))
                                ) : (
                                    <View style={styles.emptyState}>
                                        <Caption style={styles.sectionSubtitle}>No triggers configured for this agent</Caption>
                                    </View>
                                )
                            ) : (
                                <Caption style={styles.sectionSubtitle}>Select an agent to manage triggers</Caption>
                            )}
                        </View>

                        <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
                            <Caption style={styles.signOutText}>Sign Out</Caption>
                        </TouchableOpacity>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
};
