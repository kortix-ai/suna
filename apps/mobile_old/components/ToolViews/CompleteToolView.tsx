import { useTheme } from '@/hooks/useThemeColor';
import { CheckCircle, ListChecks, Paperclip, Sparkles, Trophy } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { MarkdownComponent } from '../../utils/markdown-renderer';
import { FileAttachment } from '../FileAttachment';
import { Body, Caption } from '../Typography';
import { ToolViewProps } from './ToolViewRegistry';

export interface CompleteToolViewProps extends ToolViewProps {
    messages?: any[]; // Add messages prop to access previous message
}

interface CompleteContent {
    summary?: string;
    result?: string;
    tasksCompleted?: string[];
    attachments?: string[];
}

const extractCompleteData = (toolCall: any, messages?: any[]): CompleteContent => {
    // For complete tool, data comes from the PREVIOUS message in the conversation
    // The complete tool is a termination signal that refers to the previous message
    let summary = '';
    let attachments: string[] = [];
    let tasksCompleted: string[] = [];

    console.log('🔍 EXTRACT COMPLETE DATA - toolCall:', toolCall?.functionName || toolCall?.name);
    console.log('🔍 EXTRACT COMPLETE DATA - messages count:', messages?.length || 0);

    if (messages && messages.length > 0) {
        // Find the message that contains this complete tool call
        let currentMessageIndex = -1;

        // Try different ways to find the current message
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];

            // Check if this message contains the complete tool call
            if (msg.content && typeof msg.content === 'string') {
                if (msg.content.includes('<invoke name="complete"') ||
                    msg.content.includes('"function_name":"complete"') ||
                    msg.content.includes('complete')) {
                    currentMessageIndex = i;
                    break;
                }
            }
        }

        console.log('🔍 FOUND CURRENT MESSAGE INDEX:', currentMessageIndex);

        // If we found the current message, get the previous one
        if (currentMessageIndex > 0) {
            const previousMessage = messages[currentMessageIndex - 1];
            console.log('🔍 PREVIOUS MESSAGE:', previousMessage?.type, typeof previousMessage?.content);
            console.log('🔍 PREVIOUS MESSAGE CONTENT:', JSON.stringify(previousMessage?.content, null, 2));

            // Handle different message types that might contain the content
            if (previousMessage &&
                (previousMessage.type === 'assistant' || previousMessage.type === 'assistant_response_end') &&
                previousMessage.content) {

                // Extract content from previous message
                let extractedContent = '';

                if (typeof previousMessage.content === 'string') {
                    extractedContent = previousMessage.content;
                } else if (typeof previousMessage.content === 'object') {
                    // Handle OpenAI/Claude API response structure
                    if (previousMessage.content.choices && previousMessage.content.choices.length > 0) {
                        // OpenAI/Claude API format: choices[0].message.content
                        extractedContent = previousMessage.content.choices[0]?.message?.content || '';
                    } else {
                        // Try different object properties that might contain the content
                        extractedContent = previousMessage.content.text ||
                            previousMessage.content.content ||
                            previousMessage.content.message ||
                            previousMessage.content.body ||
                            '';

                        // If still empty, try to find any string property (but skip common metadata fields)
                        if (!extractedContent) {
                            for (const key in previousMessage.content) {
                                if (typeof previousMessage.content[key] === 'string' &&
                                    previousMessage.content[key].length > 10 &&
                                    !['model', 'id', 'object', 'created', 'finish_reason', 'role'].includes(key)) {
                                    extractedContent = previousMessage.content[key];
                                    break;
                                }
                            }
                        }
                    }
                }

                console.log('🔍 EXTRACTED CONTENT:', extractedContent.substring(0, 100));

                if (extractedContent) {
                    summary = String(extractedContent);

                    // Clean up function calls from the content
                    if (typeof summary === 'string') {
                        summary = summary
                            .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
                            .replace(/<invoke name="complete"[\s\S]*?<\/invoke>/g, '')
                            .trim();
                    }

                    console.log('🔍 CLEANED SUMMARY:', summary.substring(0, 100));
                }
            }

            // Parse attachments from previous message if mentioned
            const attachmentMatches = summary.match(/attachments?[=:]\s*["']([^"']+)["']/gi);
            if (attachmentMatches) {
                attachments = attachmentMatches.flatMap(match => {
                    const extracted = match.match(/["']([^"']+)["']/);
                    return extracted ? extracted[1].split(',').map(f => f.trim()) : [];
                });
            }

            // Parse tasks from summary if it contains bullet points
            const taskMatches = summary.match(/[•\-\*]\s*([^\n]+)/g);
            if (taskMatches) {
                tasksCompleted = taskMatches.map((task: string) =>
                    task.replace(/^[•\-\*]\s*/, '').trim()
                );
            }
        }
    }

    // Fallback to tool parameters if no previous message found
    if (!summary) {
        summary = toolCall?.parameters?.summary ||
            toolCall?.parameters?.text ||
            toolCall?.input?.summary ||
            toolCall?.input?.text ||
            toolCall?.parameters?.message ||
            toolCall?.input?.message || '';
    }

    // Remove duplicates
    attachments = [...new Set(attachments)].filter(attachment => attachment.length > 0);

    console.log('🔍 FINAL EXTRACTED DATA:', {
        summary: summary.substring(0, 50),
        attachments: attachments.length,
        tasksCompleted: tasksCompleted.length
    });

    return {
        summary: summary || '',
        attachments,
        tasksCompleted,
    };
};

export const CompleteToolView: React.FC<CompleteToolViewProps> = ({
    toolCall,
    messages,
    isStreaming = false,
    isSuccess = true,
    onFilePress,
    sandboxId,
    ...otherProps
}) => {
    const theme = useTheme();
    const [progress] = useState(isStreaming ? 0 : 100);

    // Success animation
    const sparkleOpacity = useSharedValue(0);
    const sparkleScale = useSharedValue(0.8);

    useEffect(() => {
        if (!isStreaming && isSuccess) {
            sparkleOpacity.value = withRepeat(
                withSequence(
                    withTiming(1, { duration: 600 }),
                    withTiming(0, { duration: 600 })
                ),
                3,
                false
            );
            sparkleScale.value = withRepeat(
                withSequence(
                    withTiming(1.2, { duration: 600 }),
                    withTiming(0.8, { duration: 600 })
                ),
                3,
                false
            );
        }
    }, [isStreaming, isSuccess]);

    const sparkleAnimatedStyle = useAnimatedStyle(() => ({
        opacity: sparkleOpacity.value,
        transform: [{ scale: sparkleScale.value }],
    }));

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
        successContainer: {
            alignItems: 'center',
            paddingVertical: 32,
        },
        successIcon: {
            width: 80,
            height: 80,
            borderRadius: 40,
            backgroundColor: theme.primary + '20',
            justifyContent: 'center',
            alignItems: 'center',
            marginBottom: 16,
            position: 'relative',
        },
        sparkleIcon: {
            position: 'absolute',
            top: -4,
            right: -4,
        },
        summaryContainer: {
            backgroundColor: theme.muted + '20',
            borderRadius: 12,
            padding: 16,
            marginBottom: 16,
        },
        sectionHeader: {
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 12,
        },
        sectionTitle: {
            color: theme.mutedForeground,
            fontWeight: '600',
            marginLeft: 8,
        },
        taskItem: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            backgroundColor: theme.muted + '20',
            borderRadius: 8,
            padding: 12,
            marginBottom: 8,
        },
        taskIcon: {
            marginRight: 12,
            marginTop: 2,
        },
        taskContent: {
            flex: 1,
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
            fontWeight: '600',
        },
        emptySubtitle: {
            color: theme.mutedForeground,
            textAlign: 'center',
            lineHeight: 20,
        },
        progressContainer: {
            marginBottom: 16,
        },
        progressHeader: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
        },
        progressText: {
            color: theme.mutedForeground,
            fontSize: 14,
        },
        progressBar: {
            height: 4,
            backgroundColor: theme.muted + '40',
            borderRadius: 2,
        },
        progressFill: {
            height: '100%',
            backgroundColor: theme.primary,
            borderRadius: 2,
        },
    });

    if (!toolCall) {
        return (
            <View style={styles.container}>
                <View style={styles.emptyState}>
                    <View style={styles.emptyIcon}>
                        <CheckCircle size={32} color={theme.mutedForeground} />
                    </View>
                    <Body style={styles.emptyTitle}>No task selected</Body>
                    <Body style={styles.emptySubtitle}>
                        Select a completed task to view its details
                    </Body>
                </View>
            </View>
        );
    }

    const { summary, attachments, tasksCompleted } = extractCompleteData(toolCall, messages);
    const hasContent = summary || (attachments && attachments.length > 0) || (tasksCompleted && tasksCompleted.length > 0);

    console.log('🔍 COMPLETE TOOL VIEW - hasContent:', hasContent);

    // Don't render if no meaningful content (prevents empty duplicate rendering)
    if (!hasContent && !isStreaming) {
        return (
            <View style={styles.container}>
                <View style={styles.successContainer}>
                    <View style={styles.successIcon}>
                        <Trophy size={40} color={theme.primary} />
                        <Animated.View style={[styles.sparkleIcon, sparkleAnimatedStyle]}>
                            <Sparkles size={20} color="#FFD700" />
                        </Animated.View>
                    </View>
                    <Body style={styles.emptyTitle}>Task Completed!</Body>
                    <Body style={styles.emptySubtitle}>
                        Successfully finished the assigned task
                    </Body>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                <View style={styles.section}>
                    {/* Summary Section */}
                    {summary && (
                        <View style={styles.summaryContainer}>
                            <MarkdownComponent>
                                {summary}
                            </MarkdownComponent>
                        </View>
                    )}

                    {/* Tasks Completed Section */}
                    {tasksCompleted && tasksCompleted.length > 0 && (
                        <View style={{ marginBottom: 16 }}>
                            <View style={styles.sectionHeader}>
                                <ListChecks size={16} color={theme.mutedForeground} />
                                <Caption style={styles.sectionTitle}>
                                    Tasks Completed
                                </Caption>
                            </View>
                            {tasksCompleted.map((task, index) => (
                                <View key={index} style={styles.taskItem}>
                                    <CheckCircle size={16} color={theme.primary} style={styles.taskIcon} />
                                    <View style={styles.taskContent}>
                                        <MarkdownComponent>
                                            {task}
                                        </MarkdownComponent>
                                    </View>
                                </View>
                            ))}
                        </View>
                    )}

                    {/* Attachments Section */}
                    {attachments && attachments.length > 0 && (
                        <View style={{ marginBottom: 16 }}>
                            <View style={styles.sectionHeader}>
                                <Paperclip size={16} color={theme.mutedForeground} />
                                <Caption style={styles.sectionTitle}>
                                    Files ({attachments.length})
                                </Caption>
                            </View>
                            <View style={styles.attachmentsList}>
                                {attachments.map((attachment, index) => (
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
                    )}

                    {/* Progress Section for Streaming */}
                    {isStreaming && (
                        <View style={styles.progressContainer}>
                            <View style={styles.progressHeader}>
                                <Caption style={styles.progressText}>
                                    Completing task...
                                </Caption>
                                <Caption style={styles.progressText}>
                                    {progress}%
                                </Caption>
                            </View>
                            <View style={styles.progressBar}>
                                <View style={[styles.progressFill, { width: `${progress}%` }]} />
                            </View>
                        </View>
                    )}
                </View>
            </ScrollView>
        </View>
    );
}; 