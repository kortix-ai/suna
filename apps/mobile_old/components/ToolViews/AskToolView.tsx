import { useTheme } from '@/hooks/useThemeColor';
import { MessageSquare, Paperclip } from 'lucide-react-native';
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { FileAttachment } from '../FileAttachment';
import { Body, Caption } from '../Typography';

export interface AskToolViewProps {
    toolCall?: any;
    toolContent?: string;
    isStreaming?: boolean;
    isSuccess?: boolean;
    onFilePress?: (filePath: string) => void;
    sandboxId?: string;
}

const extractAskData = (toolCall: any, toolContent?: string) => {
    if (!toolContent) {
        console.log('AskToolView: No content provided');
        return { text: '', attachments: [] };
    }

    try {
        const parsedContent = JSON.parse(toolContent);
        const args = parsedContent.tool_execution?.arguments || {};

        // Extract attachments/files
        let attachments: string[] = [];
        const rawAttachments = args.attachments || args.files || [];

        if (Array.isArray(rawAttachments)) {
            attachments = rawAttachments.filter(item => typeof item === 'string' && item.trim());
        } else if (typeof rawAttachments === 'string' && rawAttachments.trim()) {
            // Handle comma-separated strings
            attachments = rawAttachments.split(',').map(file => file.trim()).filter(file => file.length > 0);
        }

        const text = args.text || '';

        return {
            text,
            attachments,
        };
    } catch (error) {
        console.error('AskToolView: Error parsing tool content:', error);
        return { text: '', attachments: [] };
    }
};

export const AskToolView: React.FC<AskToolViewProps> = ({
    toolCall,
    toolContent,
    isStreaming = false,
    isSuccess = true,
    onFilePress,
    sandboxId,
    ...otherProps
}) => {
    const theme = useTheme();

    const styles = StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: theme.background,
        },

        content: {
            flex: 1,
        },
        section: {
            padding: 16,
        },
        sectionTitle: {
            color: theme.foreground,
            marginBottom: 12,
            fontWeight: '600' as const,
        },
        attachmentsList: {
            gap: 12,
        },
        emptyState: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 32,
        },
        emptyIcon: {
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: theme.muted + '20',
            justifyContent: 'center',
            alignItems: 'center',
            marginBottom: 16,
        },
        emptyTitle: {
            color: theme.foreground,
            textAlign: 'center',
            marginBottom: 8,
        },
        emptySubtitle: {
            color: theme.mutedForeground,
            textAlign: 'center',
            lineHeight: 20,
        },
        footer: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderTopWidth: 1,
            borderTopColor: theme.border,
            backgroundColor: theme.muted + '10',
        },
        footerBadge: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.border,
        },
        footerText: {
            color: theme.mutedForeground,
            fontSize: 12,
        },
    });

    if (!toolCall) {
        return (
            <View style={styles.container}>
                <View style={styles.emptyState}>
                    <View style={styles.emptyIcon}>
                        <MessageSquare size={32} color={theme.mutedForeground} />
                    </View>
                    <Body style={styles.emptyTitle}>No question selected</Body>
                    <Body style={styles.emptySubtitle}>
                        Select a question to view its details
                    </Body>
                </View>
            </View>
        );
    }

    const { attachments } = extractAskData(toolCall, toolContent);

    return (
        <View style={styles.container}>
            <ScrollView style={styles.content}>
                {Array.isArray(attachments) && attachments.length > 0 ? (
                    <View style={styles.section}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                            <Paperclip size={16} color={theme.mutedForeground} />
                            <Caption style={[styles.sectionTitle, { marginLeft: 8, marginBottom: 0 }]}>
                                Files ({attachments.length})
                            </Caption>
                        </View>

                        <View style={styles.attachmentsList}>
                            {attachments.map((attachment: string, index: number) => (
                                <FileAttachment
                                    key={index}
                                    filepath={attachment}
                                    sandboxId={sandboxId}
                                    onPress={onFilePress}
                                    showPreview={true}
                                    layout="grid"
                                />
                            ))}
                        </View>
                    </View>
                ) : (
                    <View style={styles.emptyState}>
                        <View style={styles.emptyIcon}>
                            <MessageSquare size={32} color={theme.mutedForeground} />
                        </View>
                        <Body style={styles.emptyTitle}>Question Asked</Body>
                        <Body style={styles.emptySubtitle}>
                            No files attached to this question
                        </Body>
                    </View>
                )}
            </ScrollView>
        </View>
    );
}; 