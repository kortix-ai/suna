import { useTheme } from '@/hooks/useThemeColor';
import { ExternalLink, Rocket, XCircle } from 'lucide-react-native';
import React from 'react';
import {
    ActivityIndicator,
    Alert,
    Linking,
    ScrollView,
    StyleSheet,
    TouchableOpacity,
    View
} from 'react-native';
import { Body, Caption } from '../Typography';
import { Card, CardContent } from '../ui/Card';
import { TerminalView } from '../ui/TerminalView';
import { ToolViewProps } from './ToolViewRegistry';

export interface DeployToolViewProps extends ToolViewProps {
    assistantContent?: string;
    toolContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
    messages?: any[];
}

const extractDeployData = (toolCall?: any, toolContent?: string, assistantContent?: string, messages?: any[]) => {
    let projectName = '';
    let directoryPath = '';
    let deployUrl = '';
    let isSuccess = true;
    let statusMessage = '';
    let deployOutput = '';

    // Extract project info from tool call parameters (for streaming/loading state)
    if (toolCall?.parameters) {
        projectName = toolCall.parameters.name || '';
        directoryPath = toolCall.parameters.directory_path || '';
    }

    // Parse the specific tool result content (this is the EXACT result for THIS tool execution)
    if (toolContent) {
        try {
            const parsed = JSON.parse(toolContent);

            if (parsed.tool_execution) {
                const toolExecution = parsed.tool_execution;

                // Extract arguments
                if (toolExecution.arguments) {
                    projectName = toolExecution.arguments.name || projectName;
                    directoryPath = toolExecution.arguments.directory_path || directoryPath;
                }

                // Extract result data
                if (toolExecution.result) {
                    const result = toolExecution.result;

                    // Get success status - this is the actual result
                    if (result.success !== undefined) {
                        isSuccess = result.success;
                    }

                    // Extract output data
                    if (result.output) {
                        if (result.output.message) {
                            statusMessage = result.output.message;
                        }

                        // Get the deployment log output
                        const outputStr = result.output.output || result.output;
                        if (outputStr) {
                            deployOutput = outputStr;

                            // Extract deployment URL from output
                            const urlMatch = outputStr.match(/https:\/\/[^\s]+\.pages\.dev[^\s]*/);
                            if (urlMatch) {
                                deployUrl = urlMatch[0];
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // If parsing fails, treat as raw content
            deployOutput = toolContent;
            const urlMatch = toolContent.match(/https:\/\/[^\s]+\.pages\.dev[^\s]*/);
            if (urlMatch) {
                deployUrl = urlMatch[0];
            }
        }
    }

    return {
        projectName,
        directoryPath,
        deployUrl,
        isSuccess,
        statusMessage,
        deployOutput
    };
};

export const DeployToolView: React.FC<DeployToolViewProps> = ({
    toolCall,
    toolContent,
    assistantContent,
    isStreaming = false,
    messages,
    ...props
}) => {
    console.log('🚀 DEPLOY TOOL RECEIVED:', !!toolContent, toolContent?.length || 0);
    const theme = useTheme();

    // Convert color-mix(in oklab, var(--muted) 20%, transparent) to hex
    const mutedBg = theme.muted === '#e8e8e8' ? '#e8e8e833' : '#30303033';

    // Link colors based on theme
    const linkColor = theme.background === '#ffffff' ? '#155dfc' : '#51a2ff';

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
        statusRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
        },
        statusText: {
            fontWeight: '600' as const,
        },
        successText: {
            color: '#009966',
        },
        errorText: {
            color: '#ef4444',
        },
        urlContainer: {
            backgroundColor: theme.muted === '#e8e8e8' ? '#e8e8e820' : '#30303020',
            padding: 12,
            borderRadius: 16,
            marginBottom: 12,
        },
        urlText: {
            color: linkColor,
            fontFamily: 'monospace',
        },
        actionButton: {
            backgroundColor: '#009966',
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
        },
        actionButtonText: {
            color: '#ffffff',
            fontWeight: '600' as const,
        },
        liveBadge: {
            backgroundColor: '#009966',
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 12,
            alignSelf: 'flex-start',
        },
        liveBadgeText: {
            color: '#ffffff',
            fontSize: 12,
            fontWeight: '600' as const,
        },
    });

    if (!toolContent) {
        console.log('❌ DEPLOY TOOL: NO CONTENT');
        return (
            <View style={styles.container}>
                <View style={styles.emptyState}>
                    <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                        No deployment data available
                    </Body>
                </View>
            </View>
        );
    }

    let resultData;
    try {
        resultData = JSON.parse(toolContent);
        console.log('✅ DEPLOY TOOL: PARSED DATA', typeof resultData, !!resultData.success);
    } catch (error) {
        console.log('❌ DEPLOY TOOL: PARSE ERROR', error);
        return (
            <View style={styles.container}>
                <View style={styles.emptyState}>
                    <Body style={{ color: theme.destructive, textAlign: 'center' }}>
                        Failed to parse deployment data
                    </Body>
                </View>
            </View>
        );
    }

    const isSuccess = resultData.success;
    const outputText = resultData.output || '';

    console.log('📝 DEPLOY TOOL: OUTPUT TEXT', outputText.substring(0, 100) + '...');

    // Extract deployment URL from output
    const deploymentUrlMatch = outputText.match(/https:\/\/[^\s]+\.pages\.dev[^\s]*/);
    const deploymentUrl = deploymentUrlMatch ? deploymentUrlMatch[0] : null;

    console.log('🔗 DEPLOY TOOL: EXTRACTED URL', deploymentUrl);

    const {
        projectName,
        directoryPath,
        deployUrl,
        isSuccess: actualIsSuccess,
        statusMessage,
        deployOutput
    } = extractDeployData(toolCall, toolContent, assistantContent, messages);

    const handleLinkPress = (url: string) => {
        Linking.openURL(url).catch(() => {
            Alert.alert('Error', 'Failed to open URL');
        });
    };

    const renderLoading = () => (
        <View style={styles.loadingContainer}>
            <Rocket size={48} color={theme.secondary} />
            <ActivityIndicator size="large" color={theme.secondary} />
            <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                Deploying Website
            </Body>
            <Caption style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                {projectName || 'Processing deployment...'}
            </Caption>
        </View>
    );

    const renderResults = () => (
        <ScrollView style={{ flex: 1 }}>
            {/* Deployment Status */}
            <View style={styles.section}>
                <View style={styles.sectionTitle}>
                    <Rocket size={16} color={theme.foreground} />
                    <Body style={styles.sectionTitleText}>Deployment Status</Body>
                    {actualIsSuccess && (
                        <View style={styles.liveBadge}>
                            <Body style={styles.liveBadgeText}>Live</Body>
                        </View>
                    )}
                </View>
                <Card
                    style={{
                        backgroundColor: actualIsSuccess ? mutedBg : '#ef444420',
                        borderColor: actualIsSuccess ? theme.muted : '#ef4444',
                        padding: actualIsSuccess ? 12 : 24,
                    }}
                    bordered
                    elevated={false}
                >
                    <CardContent style={{ padding: 0 }}>
                        <View style={styles.statusRow}>
                            {actualIsSuccess ? (
                                <></>
                            ) : (
                                <>
                                    <XCircle size={20} color="#ef4444" />
                                    <Body style={[styles.statusText, styles.errorText]}>
                                        {statusMessage || 'Deployment Failed'}
                                    </Body>
                                </>
                            )}
                        </View>

                        {/* Deploy URL */}
                        {deployUrl && (
                            <>
                                <View style={styles.urlContainer}>
                                    <Body style={styles.urlText}>{deployUrl}</Body>
                                </View>

                                <TouchableOpacity
                                    style={styles.actionButton}
                                    onPress={() => handleLinkPress(deployUrl)}
                                    activeOpacity={0.7}
                                >
                                    <ExternalLink size={16} color="#ffffff" />
                                    <Body style={styles.actionButtonText}>Open Website</Body>
                                </TouchableOpacity>
                            </>
                        )}
                    </CardContent>
                </Card>
            </View>

            {/* Deployment Logs */}
            {deployOutput && (
                <View style={styles.section}>
                    <TerminalView
                        output={deployOutput}
                        title="Deployment Log"
                        exitCode={actualIsSuccess ? 0 : 1}
                        showError={false}
                    />
                </View>
            )}
        </ScrollView>
    );

    const renderEmpty = () => (
        <View style={styles.emptyState}>
            <Rocket size={48} color={theme.mutedForeground} />
            <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                No deployment results available
            </Body>
        </View>
    );

    return (
        <View style={styles.container}>
            {isStreaming ? renderLoading() : (deployUrl || deployOutput ? renderResults() : renderEmpty())}
        </View>
    );
}; 