import { useTheme } from '@/hooks/useThemeColor';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Body, Caption } from '../Typography';
import { Card, CardContent } from '../ui/Card';
import { ToolViewProps } from './ToolViewRegistry';

interface GenericToolViewProps extends ToolViewProps {
    toolContent?: string;
    assistantContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
}

const extractGenericToolData = (toolCall?: any, toolContent?: string) => {
    let functionName = '';
    let parameters: any = {};
    let result: any = null;
    let isSuccess = true;
    let errorMessage = '';

    // Extract from tool call parameters
    if (toolCall?.parameters) {
        parameters = toolCall.parameters;
        functionName = toolCall.functionName || toolCall.name || '';
    }

    // Parse tool content if available
    if (toolContent) {
        try {
            const parsed = JSON.parse(toolContent);

            if (parsed.tool_execution) {
                const toolExecution = parsed.tool_execution;

                // Extract function name
                functionName = toolExecution.function_name ||
                    toolExecution.xml_tag_name ||
                    functionName;

                // Extract arguments
                if (toolExecution.arguments) {
                    parameters = { ...parameters, ...toolExecution.arguments };
                }

                // Extract result
                if (toolExecution.result) {
                    result = toolExecution.result;

                    if (result.success !== undefined) {
                        isSuccess = result.success;
                    }

                    if (result.error) {
                        errorMessage = result.error;
                    }
                }
            }
        } catch (e) {
            // If parsing fails, treat as raw result
            result = toolContent;
            isSuccess = false;
            errorMessage = 'Failed to parse tool content';
        }
    }

    return {
        functionName,
        parameters,
        result,
        isSuccess,
        errorMessage
    };
};

export const GenericToolView: React.FC<GenericToolViewProps> = ({
    toolCall,
    toolContent,
    isStreaming = false,
    isSuccess = true,
    ...props
}) => {
    const theme = useTheme();

    // Convert color-mix(in oklab, var(--muted) 20%, transparent) to hex
    const mutedBg = theme.muted === '#e8e8e8' ? '#e8e8e833' : '#30303033';

    const styles = StyleSheet.create({
        container: {
            flex: 1,
            padding: 16,
        },
        emptyState: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
        },
        emptyText: {
            fontSize: 16,
        },
        header: {
            marginBottom: 16,
        },
        toolName: {
            color: theme.foreground,
            marginBottom: 8,
        },
        statusBadge: {
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 4,
            alignSelf: 'flex-start',
        },
        statusText: {
            fontSize: 12,
            fontWeight: '600' as const,
        },
        section: {
            marginBottom: 16,
        },
        sectionTitle: {
            color: theme.foreground,
            marginBottom: 8,
            fontWeight: '600' as const,
        },
        parameterKey: {
            color: theme.mutedForeground,
            fontSize: 12,
            marginBottom: 4,
        },
        parameterValue: {
            color: theme.foreground,
            fontFamily: 'monospace',
            fontSize: 13,
        },
        resultText: {
            color: theme.foreground,
            fontFamily: 'monospace',
            fontSize: 13,
        },
        errorText: {
            color: theme.destructive,
            fontFamily: 'monospace',
            fontSize: 13,
        },
    });

    console.log('🔧 GENERIC TOOL RECEIVED:', !!toolContent, toolContent?.length || 0);

    if (!toolContent && !isStreaming && !toolCall) {
        console.log('❌ GENERIC TOOL: NO CONTENT');
        return (
            <View style={[styles.container, { backgroundColor: theme.background }]}>
                <View style={styles.emptyState}>
                    <Body style={[styles.emptyText, { color: theme.mutedForeground }]}>
                        No tool data available
                    </Body>
                </View>
            </View>
        );
    }

    const {
        functionName,
        parameters,
        result,
        isSuccess: actualIsSuccess,
        errorMessage
    } = extractGenericToolData(toolCall, toolContent);

    const displayName = functionName || 'Unknown Tool';

    return (
        <View style={[styles.container, { backgroundColor: theme.background }]}>
            {parameters && Object.keys(parameters).length > 0 && (
                <View style={styles.section}>
                    <Body style={styles.sectionTitle}>Parameters</Body>
                    {Object.entries(parameters).map(([key, value]) => (
                        <Card
                            key={key}
                            style={{
                                backgroundColor: mutedBg,
                                borderColor: theme.muted,
                                marginBottom: 8,
                                padding: 12,
                            }}
                            bordered
                            elevated={false}
                        >
                            <CardContent style={{ padding: 0 }}>
                                <Caption style={styles.parameterKey}>{key}</Caption>
                                <Body style={styles.parameterValue}>
                                    {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                                </Body>
                            </CardContent>
                        </Card>
                    ))}
                </View>
            )}

            {result && (
                <View style={styles.section}>
                    <Body style={styles.sectionTitle}>Result</Body>
                    <Card
                        style={{
                            backgroundColor: mutedBg,
                            borderColor: theme.muted,
                        }}
                        bordered
                        elevated={false}
                    >
                        <CardContent style={{ padding: 0 }}>
                            <Body style={styles.resultText}>
                                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
                            </Body>
                        </CardContent>
                    </Card>
                </View>
            )}

            {errorMessage && (
                <View style={styles.section}>
                    <Body style={[styles.sectionTitle, { color: theme.destructive }]}>Error</Body>
                    <Card
                        style={{
                            backgroundColor: mutedBg,
                            borderColor: theme.destructive,
                        }}
                        bordered
                        elevated={false}
                    >
                        <CardContent style={{ padding: 0 }}>
                            <Body style={styles.errorText}>
                                {errorMessage}
                            </Body>
                        </CardContent>
                    </Card>
                </View>
            )}
        </View>
    );
}; 