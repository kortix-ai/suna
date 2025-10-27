import { useColorScheme } from '@/hooks/useColorScheme';
import { useTheme } from '@/hooks/useThemeColor';
import {
    StopCircle
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TerminalView } from '../ui/TerminalView';
import { ToolViewProps } from './ToolViewRegistry';

interface TerminateCommandToolViewProps extends ToolViewProps {
    assistantContent?: string;
    toolContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
    toolCall?: any;
}

const extractCommandData = (toolCall?: any, toolContent?: string, assistantContent?: string) => {
    let sessionName = '';
    let output = '';
    let isSuccess = true;
    let errorMessage = '';

    // Extract from tool call parameters
    if (toolCall?.parameters) {
        sessionName = toolCall.parameters.session_name || toolCall.parameters.sessionName || '';
        output = toolCall.parameters.output || '';
    }

    // Parse tool content if available
    if (toolContent) {
        try {
            const parsed = JSON.parse(toolContent);

            if (parsed.tool_execution) {
                const toolExecution = parsed.tool_execution;

                // Extract arguments
                if (toolExecution.arguments) {
                    sessionName = toolExecution.arguments.session_name || toolExecution.arguments.sessionName || sessionName;
                    output = toolExecution.arguments.output || output;
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
                        output = result.error;
                    }

                    if (result.output) {
                        output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
                    }
                }
            }
        } catch (error) {
            console.error('Error parsing tool content:', error);
        }
    }

    // Try to extract session name from assistant content if not found
    if (!sessionName && assistantContent) {
        try {
            const parsed = JSON.parse(assistantContent);
            if (parsed.content) {
                const sessionMatch = parsed.content.match(
                    /<terminate-command[^>]*session_name=["']([^"']+)["'][^>]*>/
                );
                if (sessionMatch) {
                    sessionName = sessionMatch[1].trim();
                }
            }
        } catch (e) {
            const sessionMatch = assistantContent.match(
                /<terminate-command[^>]*session_name=["']([^"']+)["'][^>]*>/
            );
            if (sessionMatch) {
                sessionName = sessionMatch[1].trim();
            }
        }
    }

    // Determine termination success
    const terminationSuccess = output ? (
        !output.toLowerCase().includes('does not exist') &&
        (output.toLowerCase().includes('terminated') || output.toLowerCase().includes('killed'))
    ) : isSuccess;

    return {
        sessionName,
        output,
        isSuccess: terminationSuccess,
        errorMessage
    };
};

export function TerminateCommandToolView({
    name = 'terminate-command',
    toolCall,
    toolContent,
    assistantContent,
    isStreaming = false,
    isSuccess = true,
    ...props
}: TerminateCommandToolViewProps) {
    const theme = useTheme();
    const colorScheme = useColorScheme();
    const [progress, setProgress] = useState(0);

    const extractedData = extractCommandData(toolCall, toolContent, assistantContent);
    const { sessionName, output, isSuccess: terminationSuccess, errorMessage } = extractedData;

    useEffect(() => {
        if (isStreaming) {
            const timer = setInterval(() => {
                setProgress((prevProgress) => {
                    if (prevProgress >= 95) {
                        clearInterval(timer);
                        return prevProgress;
                    }
                    return prevProgress + 5;
                });
            }, 300);
            return () => clearInterval(timer);
        } else {
            setProgress(100);
        }
    }, [isStreaming]);

    const styles = StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: theme.background,
        },
        scrollView: {
            flex: 1,
        },
        content: {
            padding: 16,
        },
        loadingContainer: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20,
        },
        loadingIcon: {
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: colorScheme === 'dark' ? '#7f1d1d40' : '#fecaca',
            justifyContent: 'center',
            alignItems: 'center',
            marginBottom: 24,
        },
        loadingTitle: {
            fontSize: 18,
            fontWeight: '500',
            color: theme.foreground,
            marginBottom: 8,
        },
        loadingSubtitle: {
            fontSize: 14,
            color: theme.mutedForeground,
            marginBottom: 24,
            fontFamily: 'Monaco, monospace',
            textAlign: 'center',
        },
        progressContainer: {
            width: '100%',
            height: 4,
            backgroundColor: colorScheme === 'dark' ? '#374151' : '#e5e7eb',
            borderRadius: 2,
            marginBottom: 8,
        },
        progressBar: {
            height: 4,
            backgroundColor: colorScheme === 'dark' ? '#dc2626' : '#ef4444',
            borderRadius: 2,
        },
        progressText: {
            fontSize: 12,
            color: theme.mutedForeground,
            textAlign: 'center',
        },
        emptyState: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            paddingVertical: 48,
            paddingHorizontal: 24,
        },
        emptyIcon: {
            width: 80,
            height: 80,
            borderRadius: 40,
            backgroundColor: colorScheme === 'dark' ? '#1f2937' : '#f3f4f6',
            justifyContent: 'center',
            alignItems: 'center',
            marginBottom: 24,
        },
        emptyTitle: {
            fontSize: 20,
            fontWeight: '600',
            color: theme.foreground,
            marginBottom: 8,
        },
        emptyDescription: {
            fontSize: 14,
            color: theme.mutedForeground,
            textAlign: 'center',
            lineHeight: 20,
            maxWidth: 280,
        },
    });

    const renderLoadingState = () => (
        <View style={styles.loadingContainer}>
            <View style={styles.loadingIcon}>
                <ActivityIndicator size="large" color={colorScheme === 'dark' ? '#dc2626' : '#ef4444'} />
            </View>
            <Text style={styles.loadingTitle}>Terminating session</Text>
            <Text style={styles.loadingSubtitle}>
                {sessionName || 'Processing termination...'}
            </Text>
            <View style={styles.progressContainer}>
                <View style={[styles.progressBar, { width: `${progress}%` }]} />
            </View>
            <Text style={styles.progressText}>{progress}%</Text>
        </View>
    );

    const renderContent = () => {
        if (!sessionName) {
            return (
                <View style={styles.emptyState}>
                    <View style={styles.emptyIcon}>
                        <StopCircle size={40} color={theme.mutedForeground} />
                    </View>
                    <Text style={styles.emptyTitle}>No Session Found</Text>
                    <Text style={styles.emptyDescription}>
                        No session name was detected. Please provide a valid session to terminate.
                    </Text>
                </View>
            );
        }

        return (
            <TerminalView
                output={output}
                exitCode={terminationSuccess ? 0 : 1}
                showError={!terminationSuccess}
                title={`Session: ${sessionName}`}
            />
        );
    };

    return (
        <View style={styles.container}>
            {isStreaming ? (
                renderLoadingState()
            ) : (
                <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
                    <View style={styles.content}>
                        {renderContent()}
                    </View>
                </ScrollView>
            )}
        </View>
    );
} 