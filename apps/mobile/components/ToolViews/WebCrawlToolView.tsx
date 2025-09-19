import { useTheme } from '@/hooks/useThemeColor';
import * as Clipboard from 'expo-clipboard';
import { Check, Copy, ExternalLink, FileText, Globe } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Linking,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from 'react-native';
import { ToolViewProps } from './ToolViewRegistry';

export interface WebCrawlToolViewProps extends ToolViewProps {
    assistantContent?: string;
    toolContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
    messages?: any[];
}

const extractWebCrawlData = (toolCall?: any, toolContent?: string) => {
    let url = '';
    let content = '';
    let isSuccess = true;
    let errorMessage = '';

    // Extract from tool call parameters
    if (toolCall?.parameters) {
        url = toolCall.parameters.url || '';
    }

    // Parse tool content if available
    if (toolContent) {
        try {
            const parsed = JSON.parse(toolContent);

            if (parsed.tool_execution) {
                const toolExecution = parsed.tool_execution;

                // Extract arguments
                if (toolExecution.arguments) {
                    url = toolExecution.arguments.url || url;
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
                        const output = result.output;

                        // Extract content
                        if (output.content) {
                            content = output.content;
                        } else if (output.text) {
                            content = output.text;
                        }

                        // Extract URL from output if not already set
                        if (output.url) {
                            url = output.url;
                        }
                    }
                }
            }
        } catch (e) {
            // If parsing fails, mark as error
            isSuccess = false;
            errorMessage = 'Failed to parse crawl results';
        }
    }

    return {
        url,
        content,
        isSuccess,
        errorMessage
    };
};

const formatDomain = (url: string): string => {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.replace('www.', '');
    } catch {
        return url;
    }
};

const getContentStats = (content: string) => {
    const wordCount = content.trim().split(/\s+/).length;
    const charCount = content.length;
    const lineCount = content.split('\n').length;
    return { wordCount, charCount, lineCount };
};

export const WebCrawlToolView: React.FC<WebCrawlToolViewProps> = ({
    toolCall,
    toolContent,
    isStreaming = false,
    isSuccess = true,
    ...props
}) => {
    const theme = useTheme();
    const [copiedContent, setCopiedContent] = useState(false);
    const [progress, setProgress] = useState(0);

    console.log('🕸️ WEB CRAWL TOOL RECEIVED:', !!toolContent, toolContent?.length || 0);

    if (!toolContent && !isStreaming) {
        console.log('❌ WEB CRAWL TOOL: NO CONTENT');
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
                    No web crawl data available
                </Text>
            </View>
        );
    }

    const {
        url,
        content,
        isSuccess: actualIsSuccess,
        errorMessage
    } = extractWebCrawlData(toolCall, toolContent);

    const domain = url ? formatDomain(url) : 'Unknown';
    const contentStats = content ? getContentStats(content) : null;

    // Simulate progress when streaming
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

    const copyContent = async () => {
        if (!content) return;

        try {
            await Clipboard.setStringAsync(content);
            setCopiedContent(true);
            setTimeout(() => setCopiedContent(false), 2000);
        } catch {
            Alert.alert('Error', 'Failed to copy content');
        }
    };

    const handleLinkPress = (url: string) => {
        Linking.openURL(url).catch(console.error);
    };

    const styles = StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: theme.background,
        },
        content: {
            flex: 1,
            padding: 16,
        },
        loadingContainer: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            gap: 16,
        },
        loadingText: {
            fontSize: 16,
            color: theme.mutedForeground,
            textAlign: 'center',
        },
        loadingDomain: {
            fontSize: 12,
            color: theme.mutedForeground,
            fontFamily: 'monospace',
            textAlign: 'center',
            marginTop: 8,
        },
        progressContainer: {
            width: '100%',
            maxWidth: 300,
            height: 4,
            backgroundColor: theme.muted,
            borderRadius: 2,
            overflow: 'hidden',
            marginTop: 16,
        },
        progressBar: {
            height: '100%',
            backgroundColor: theme.secondary,
            borderRadius: 2,
        },
        progressText: {
            fontSize: 12,
            color: theme.mutedForeground,
            textAlign: 'center',
            marginTop: 8,
        },
        sectionTitle: {
            fontSize: 14,
            fontWeight: '600',
            color: theme.foreground,
            marginBottom: 12,
            flexDirection: 'row',
            alignItems: 'center',
        },
        urlContainer: {
            backgroundColor: theme.card,
            borderRadius: 12,
            padding: 16,
            marginBottom: 16,
            borderWidth: 1,
            borderColor: theme.border,
        },
        urlHeader: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
        },
        urlTitle: {
            fontSize: 14,
            fontWeight: '600',
            color: theme.foreground,
        },
        urlText: {
            fontSize: 14,
            color: theme.secondary,
            fontFamily: 'monospace',
        },
        domainText: {
            fontSize: 12,
            color: theme.mutedForeground,
            marginTop: 4,
        },
        contentContainer: {
            backgroundColor: theme.card,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.border,
            overflow: 'hidden',
        },
        contentHeader: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: 16,
            backgroundColor: theme.muted,
            borderBottomWidth: 1,
            borderBottomColor: theme.border,
        },
        contentHeaderLeft: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
        },
        contentHeaderTitle: {
            fontSize: 14,
            fontWeight: '600',
            color: theme.foreground,
        },
        contentStats: {
            flexDirection: 'row',
            gap: 8,
            marginTop: 4,
        },
        statsBadge: {
            backgroundColor: theme.secondary,
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 4,
        },
        statsBadgeText: {
            fontSize: 10,
            color: theme.secondaryForeground,
            fontWeight: '500',
        },
        contentBody: {
            padding: 16,
            maxHeight: 400,
        },
        contentText: {
            fontSize: 12,
            color: theme.foreground,
            fontFamily: 'monospace',
            lineHeight: 18,
        },
        emptyState: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            gap: 16,
        },
        emptyText: {
            fontSize: 16,
            color: theme.mutedForeground,
            textAlign: 'center',
        },
        emptySubtext: {
            fontSize: 14,
            color: theme.mutedForeground,
            textAlign: 'center',
            marginTop: 8,
        },
        iconButton: {
            padding: 8,
            borderRadius: 8,
            backgroundColor: theme.muted,
        },
        copiedButton: {
            backgroundColor: theme.secondary,
        },
    });

    const renderLoading = () => (
        <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.secondary} />
            <Text style={styles.loadingText}>Crawling Webpage</Text>
            <Text style={styles.loadingDomain}>Fetching content from {domain}</Text>
            <View style={styles.progressContainer}>
                <View style={[styles.progressBar, { width: `${progress}%` }]} />
            </View>
            <Text style={styles.progressText}>{progress}% complete</Text>
        </View>
    );

    const renderResults = () => (
        <ScrollView style={styles.content}>
            {/* URL Section */}
            <View style={{ marginBottom: 16 }}>
                <View style={[styles.sectionTitle, { marginBottom: 8 }]}>
                    <Globe size={16} color={theme.foreground} />
                    <Text style={[styles.sectionTitle, { marginLeft: 8, marginBottom: 0 }]}>Source URL</Text>
                </View>
                <TouchableOpacity
                    style={styles.urlContainer}
                    onPress={() => handleLinkPress(url)}
                    activeOpacity={0.7}
                >
                    <View style={styles.urlHeader}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.urlText} numberOfLines={2}>{url}</Text>
                            <Text style={styles.domainText}>{domain}</Text>
                        </View>
                        <ExternalLink size={20} color={theme.mutedForeground} />
                    </View>
                </TouchableOpacity>
            </View>

            {/* Content Section */}
            <View style={{ marginBottom: 16 }}>
                <View style={[styles.sectionTitle, { marginBottom: 8 }]}>
                    <FileText size={16} color={theme.foreground} />
                    <Text style={[styles.sectionTitle, { marginLeft: 8, marginBottom: 0 }]}>Extracted Content</Text>
                </View>

                {content ? (
                    <View style={styles.contentContainer}>
                        <View style={styles.contentHeader}>
                            <View style={styles.contentHeaderLeft}>
                                <FileText size={16} color={theme.foreground} />
                                <View>
                                    <Text style={styles.contentHeaderTitle}>Page Content</Text>
                                    {contentStats && (
                                        <View style={styles.contentStats}>
                                            <View style={styles.statsBadge}>
                                                <Text style={styles.statsBadgeText}>{contentStats.wordCount} words</Text>
                                            </View>
                                            <View style={styles.statsBadge}>
                                                <Text style={styles.statsBadgeText}>{contentStats.charCount} chars</Text>
                                            </View>
                                            <View style={styles.statsBadge}>
                                                <Text style={styles.statsBadgeText}>{contentStats.lineCount} lines</Text>
                                            </View>
                                        </View>
                                    )}
                                </View>
                            </View>
                            <TouchableOpacity
                                style={[styles.iconButton, copiedContent && styles.copiedButton]}
                                onPress={copyContent}
                                activeOpacity={0.7}
                            >
                                {copiedContent ? (
                                    <Check size={16} color={theme.secondary} />
                                ) : (
                                    <Copy size={16} color={theme.foreground} />
                                )}
                            </TouchableOpacity>
                        </View>
                        <ScrollView style={styles.contentBody}>
                            <Text style={styles.contentText}>{content}</Text>
                        </ScrollView>
                    </View>
                ) : (
                    <View style={styles.emptyState}>
                        <FileText size={48} color={theme.mutedForeground} />
                        <Text style={styles.emptyText}>No Content Extracted</Text>
                        <Text style={styles.emptySubtext}>
                            The webpage might be restricted, empty, or require JavaScript to load content
                        </Text>
                    </View>
                )}
            </View>
        </ScrollView>
    );

    const renderEmpty = () => (
        <View style={styles.emptyState}>
            <Globe size={48} color={theme.mutedForeground} />
            <Text style={styles.emptyText}>No URL Detected</Text>
            <Text style={styles.emptySubtext}>
                Unable to extract a valid URL from the crawling request
            </Text>
        </View>
    );

    return (
        <View style={styles.container}>
            {isStreaming ? renderLoading() :
                url ? renderResults() : renderEmpty()}
        </View>
    );
}; 