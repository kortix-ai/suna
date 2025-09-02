import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Colors } from '../../constants/Colors';
import { useColorScheme } from '../../hooks/useColorScheme';
import { H4 } from '../Typography';
import { TerminalView } from '../ui/TerminalView';
import { ToolViewProps } from './ToolViewRegistry';

interface CommandToolViewProps extends ToolViewProps {
    assistantContent?: string;
    toolContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
    toolCall?: any;
    messages?: any[];
}

const extractCommandData = (toolCall?: any, toolContent?: string) => {
    let command = '';
    let output = '';
    let exitCode: number | null = null;
    let sessionName = '';
    let cwd = '';
    let isSuccess = true;
    let errorMessage = '';

    // Extract from tool call parameters
    if (toolCall?.parameters) {
        command = toolCall.parameters.command || '';
        sessionName = toolCall.parameters.session_name || '';
        cwd = toolCall.parameters.cwd || '';
        output = toolCall.parameters.output || '';
        exitCode = toolCall.parameters.exit_code !== undefined ? toolCall.parameters.exit_code : null;
    }

    // Parse tool content if available
    if (toolContent) {
        try {
            const parsed = JSON.parse(toolContent);

            if (parsed.tool_execution) {
                const toolExecution = parsed.tool_execution;

                // Extract arguments
                if (toolExecution.arguments) {
                    command = toolExecution.arguments.command || command;
                    sessionName = toolExecution.arguments.session_name || sessionName;
                    cwd = toolExecution.arguments.cwd || cwd;
                }

                // Extract result
                if (toolExecution.result) {
                    const result = toolExecution.result;

                    if (result.success !== undefined) {
                        isSuccess = result.success;
                    }

                    if (result.error) {
                        errorMessage = result.error;
                    }

                    if (result.output) {
                        // Handle nested output structure: result.output.output
                        if (typeof result.output === 'object' && result.output.output) {
                            output = result.output.output;
                            exitCode = result.output.exit_code !== undefined ? result.output.exit_code : exitCode;
                        } else if (typeof result.output === 'object') {
                            // Handle object output - convert to readable text
                            if (result.output.message) {
                                output = result.output.message;
                            } else {
                                // Convert object to readable JSON string
                                output = JSON.stringify(result.output, null, 2);
                            }
                        } else {
                            output = result.output;
                        }
                    }

                    if (result.exit_code !== undefined) {
                        exitCode = result.exit_code;
                    }
                }
            }
        } catch (e) {
            // If parsing fails, treat as raw output
            output = toolContent;
            isSuccess = false;
            errorMessage = 'Failed to parse tool content';
        }
    }

    return {
        command,
        output,
        exitCode,
        sessionName,
        cwd,
        isSuccess,
        errorMessage
    };
};

export function CommandToolView({
    name = 'execute-command',
    toolCall,
    toolContent,
    isStreaming = false,
    isSuccess = true,
    ...props
}: CommandToolViewProps) {
    const colorScheme = useColorScheme();
    const theme = Colors[colorScheme ?? 'light'];
    const [showFullOutput, setShowFullOutput] = useState(true);

    console.log('⚡ COMMAND TOOL RECEIVED:', !!toolContent, toolContent?.length || 0);

    if (!toolContent && !isStreaming) {
        console.log('❌ COMMAND TOOL: NO CONTENT');
        return (
            <View style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                padding: 20,
                backgroundColor: theme.background,
            }}>
                <Text style={{
                    color: theme.mutedForeground,
                    fontSize: 16,
                    textAlign: 'center',
                }}>
                    No command execution data available
                </Text>
            </View>
        );
    }

    const {
        command,
        output,
        exitCode,
        sessionName,
        cwd,
        isSuccess: actualIsSuccess,
        errorMessage
    } = extractCommandData(toolCall, toolContent);

    const displayText = name === 'check-command-output' ? sessionName : command;
    const displayLabel = name === 'check-command-output' ? 'Session' : 'Command';
    const displayPrefix = name === 'check-command-output' ? 'tmux:' : '$';

    const styles = StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: theme.background,
        },
        content: {
            flex: 1,
        },
        loadingContainer: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 24,
        },
        loadingText: {
            marginTop: 12,
            color: theme.mutedForeground,
        },
        scrollContainer: {
            padding: 16,
        },
        emptyState: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 24,
        },
        emptyStateIcon: {
            width: 60,
            height: 60,
            borderRadius: 30,
            backgroundColor: theme.muted,
            justifyContent: 'center',
            alignItems: 'center',
            marginBottom: 16,
        },
        emptyStateText: {
            textAlign: 'center',
            color: theme.mutedForeground,
            marginTop: 8,
        },
    });

    const renderLoadingState = () => (
        <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={styles.loadingText}>
                {name === 'check-command-output' ? 'Checking command output...' : 'Executing command...'}
            </Text>
        </View>
    );

    const renderContent = () => {
        if (isStreaming) {
            return renderLoadingState();
        }

        if (!displayText) {
            return (
                <View style={styles.emptyState}>
                    <View style={styles.emptyStateIcon}>
                        <Ionicons name="terminal" size={30} color={theme.mutedForeground} />
                    </View>
                    <H4 style={{ color: theme.foreground }}>
                        {name === 'check-command-output' ? 'No Session Found' : 'No Command Found'}
                    </H4>
                    <Text style={styles.emptyStateText}>
                        {name === 'check-command-output'
                            ? 'No session name was detected. Please provide a valid session name to check.'
                            : 'No command was detected. Please provide a valid command to execute.'
                        }
                    </Text>
                </View>
            );
        }

        return (
            <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                <View style={styles.scrollContainer}>
                    <TerminalView
                        output={output}
                        exitCode={exitCode}
                        showError={true}
                        maxPreviewLines={10}
                        title="Terminal output"
                    />
                </View>
            </ScrollView>
        );
    };

    return (
        <View style={styles.container}>
            {renderContent()}
        </View>
    );
} 