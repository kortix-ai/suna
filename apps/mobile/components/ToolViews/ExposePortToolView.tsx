import { useTheme } from '@/hooks/useThemeColor';
import { AlertTriangle, ExternalLink, Monitor } from 'lucide-react-native';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Body, Caption } from '../Typography';
import { Card, CardContent } from '../ui/Card';
import { ToolViewProps } from './ToolViewRegistry';

interface ExposePortToolViewProps extends ToolViewProps {
    assistantContent?: string;
    toolContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
    toolCall?: any;
}

const extractExposePortData = (toolCall?: any, toolContent?: string) => {
    let port: number | null = null;
    let url = '';
    let message = '';
    let isSuccess = true;
    let errorMessage = '';

    // Extract from tool call parameters
    if (toolCall?.parameters) {
        port = toolCall.parameters.port || toolCall.parameters.port_number || null;
        url = toolCall.parameters.url || '';
        message = toolCall.parameters.message || '';
    }

    // Parse tool content if available
    if (toolContent) {
        try {
            const parsed = JSON.parse(toolContent);

            if (parsed.tool_execution) {
                const toolExecution = parsed.tool_execution;

                // Extract arguments
                if (toolExecution.arguments) {
                    port = toolExecution.arguments.port || toolExecution.arguments.port_number || port;
                    url = toolExecution.arguments.url || url;
                    message = toolExecution.arguments.message || message;
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
                        if (typeof result.output === 'string') {
                            // Try to parse if it's JSON
                            try {
                                const outputParsed = JSON.parse(result.output);
                                port = outputParsed.port || outputParsed.port_number || port;
                                url = outputParsed.url || url;
                                message = outputParsed.message || message;
                            } catch {
                                // If not JSON, treat as message
                                message = result.output;
                            }
                        } else {
                            port = result.output.port || result.output.port_number || port;
                            url = result.output.url || url;
                            message = result.output.message || message;
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error parsing tool content:', error);
        }
    }

    return {
        port,
        url,
        message,
        isSuccess,
        errorMessage
    };
};

export function ExposePortToolView({
    name = 'expose-port',
    toolCall,
    toolContent,
    isStreaming = false,
    isSuccess = true,
    ...props
}: ExposePortToolViewProps) {
    const theme = useTheme();

    // Convert color-mix(in oklab, var(--muted) 20%, transparent) to hex
    const mutedBg = theme.muted === '#e8e8e8' ? '#e8e8e833' : '#30303033';

    // Link colors based on theme
    const linkColor = theme.background === '#ffffff' ? '#155dfc' : '#51a2ff';

    const extractedData = extractExposePortData(toolCall, toolContent);
    const { port, url, message, isSuccess: actualIsSuccess, errorMessage } = extractedData;

    const styles = StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: theme.background,
            padding: 16,
        },
        loadingContainer: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            gap: 16,
        },
        emptyState: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            gap: 16,
        },
        section: {
            marginBottom: 16,
        },
        sectionTitle: {
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 8,
            gap: 8,
        },
        sectionTitleText: {
            color: theme.foreground,
            fontWeight: '600' as const,
        },
        urlLinkContainer: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginBottom: 12,
        },
        urlText: {
            color: linkColor,
            fontWeight: '500' as const,
            flex: 1,
        },
        portBadge: {
            backgroundColor: theme.muted,
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 16,
            alignSelf: 'flex-start',
            marginBottom: 12,
        },
        portText: {
            color: theme.foreground,
            fontSize: 12,
            fontWeight: '500' as const,
            fontFamily: 'monospace',
        },
        message: {
            color: theme.foreground,
            marginBottom: 12,
            lineHeight: 20,
        },
        warningContainer: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 8,
            marginTop: 8,
        },
        warningText: {
            color: '#F59E0B',
            fontSize: 12,
            flex: 1,
            lineHeight: 16,
        },
        errorText: {
            color: theme.destructive,
            lineHeight: 20,
        },
    });

    const handleUrlPress = (url: string) => {
        Linking.openURL(url).catch(console.error);
    };

    const renderLoadingState = () => (
        <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.secondary} />
            <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                Exposing port...
            </Body>
            {port && (
                <Caption style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                    Port: {port}
                </Caption>
            )}
        </View>
    );

    const renderContent = () => {
        if (!actualIsSuccess && errorMessage) {
            return (
                <View style={styles.emptyState}>
                    <AlertTriangle size={48} color={theme.destructive} />
                    <Body style={[styles.errorText, { textAlign: 'center' }]}>
                        {errorMessage}
                    </Body>
                </View>
            );
        }

        if (!port && !url) {
            return (
                <View style={styles.emptyState}>
                    <Monitor size={48} color={theme.mutedForeground} />
                    <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                        No Port Information
                    </Body>
                    <Caption style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                        No port exposure information is available yet. Use the expose-port command to share a local port.
                    </Caption>
                </View>
            );
        }

        return (
            <ScrollView style={{ flex: 1 }}>
                {url && (
                    <View style={styles.section}>
                        <View style={styles.sectionTitle}>
                            <ExternalLink size={16} color={theme.foreground} />
                            <Body style={styles.sectionTitleText}>Exposed URL</Body>
                        </View>
                        <Card
                            style={{
                                backgroundColor: mutedBg,
                                borderColor: theme.muted,
                            }}
                            bordered
                            elevated={false}
                        >
                            <CardContent style={{ padding: 0 }}>
                                <TouchableOpacity
                                    style={styles.urlLinkContainer}
                                    onPress={() => handleUrlPress(url)}
                                    activeOpacity={0.7}
                                >
                                    <Body style={styles.urlText} numberOfLines={2}>{url}</Body>
                                    <ExternalLink size={16} color={linkColor} />
                                </TouchableOpacity>

                                {port && (
                                    <View style={styles.portBadge}>
                                        <Caption style={styles.portText}>Port: {port}</Caption>
                                    </View>
                                )}

                                {message && (
                                    <Body style={styles.message}>{message}</Body>
                                )}

                                <View style={styles.warningContainer}>
                                    <AlertTriangle size={16} color="#F59E0B" />
                                    <Caption style={styles.warningText}>
                                        This URL might only be temporarily available and could expire after some time.
                                    </Caption>
                                </View>
                            </CardContent>
                        </Card>
                    </View>
                )}
            </ScrollView>
        );
    };

    return (
        <View style={styles.container}>
            {isStreaming ? renderLoadingState() : renderContent()}
        </View>
    );
} 