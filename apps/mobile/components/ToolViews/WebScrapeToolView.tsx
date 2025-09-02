import { useTheme } from '@/hooks/useThemeColor';
import * as Clipboard from 'expo-clipboard';
import { Calendar, Check, Copy, ExternalLink, FileText, Globe, Zap } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
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
import { ToolViewProps } from './ToolViewRegistry';

export interface WebScrapeToolViewProps extends ToolViewProps {
    assistantContent?: string;
    toolContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
    messages?: any[];
}

const extractWebScrapeData = (toolCall?: any, toolContent?: string) => {
    let url = '';
    let files: string[] = [];
    let isSuccess = true;
    let statusMessage = '';
    let errorMessage = '';

    // Extract from tool call parameters
    if (toolCall?.parameters) {
        url = toolCall.parameters.url ||
            toolCall.parameters.urls ||
            toolCall.parameters.webpage_url || '';
    }

    // Parse tool content if available
    if (toolContent) {
        try {
            const parsed = JSON.parse(toolContent);

            if (parsed.tool_execution) {
                const toolExecution = parsed.tool_execution;

                // Extract arguments
                if (toolExecution.arguments) {
                    url = toolExecution.arguments.url ||
                        toolExecution.arguments.urls ||
                        toolExecution.arguments.webpage_url || url;
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

                        // Handle string output (typical format: "Results saved to:\n- /workspace/scrape/file.json")
                        if (typeof output === 'string') {
                            statusMessage = output;

                            // Extract file paths from string
                            const fileMatches = output.match(/- (\/[^\n]+)/g);
                            if (fileMatches) {
                                files = fileMatches.map(match => match.replace('- ', ''));
                            }
                        }

                        // Handle object output (fallback)
                        if (typeof output === 'object') {
                            if (output.files && Array.isArray(output.files)) {
                                files = output.files;
                            }
                            if (output.url) {
                                url = output.url;
                            }
                            if (output.message) {
                                statusMessage = output.message;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // If parsing fails, mark as error
            isSuccess = false;
            errorMessage = 'Failed to parse scrape results';
        }
    }

    return {
        url,
        files,
        isSuccess,
        statusMessage,
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

const formatFileInfo = (filePath: string) => {
    const timestampMatch = filePath.match(/(\d{8}_\d{6})/);
    const domainMatch = filePath.match(/(\w+)_com\.json$/);
    const fileName = filePath.split('/').pop() || filePath;

    return {
        timestamp: timestampMatch ? timestampMatch[1] : '',
        domain: domainMatch ? domainMatch[1] : 'unknown',
        fileName,
        fullPath: filePath
    };
};

export const WebScrapeToolView: React.FC<WebScrapeToolViewProps> = ({
    toolCall,
    toolContent,
    isStreaming = false,
    isSuccess = true,
    ...props
}) => {
    const theme = useTheme();
    const [copiedFile, setCopiedFile] = useState<string | null>(null);
    const [progress, setProgress] = useState(0);

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
        urlText: {
            color: linkColor,
            fontFamily: 'monospace',
        },
        domainText: {
            color: theme.mutedForeground,
            fontSize: 12,
            marginTop: 4,
        },
        filesHeader: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
        },
        filesBadge: {
            backgroundColor: theme.secondary,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
        },
        filesBadgeText: {
            fontSize: 12,
            color: theme.secondaryForeground,
            fontWeight: '500',
        },
        fileItemHeader: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 12,
        },
        fileIcon: {
            width: 40,
            height: 40,
            borderRadius: 8,
            backgroundColor: theme.muted,
            justifyContent: 'center',
            alignItems: 'center',
        },
        fileDetails: {
            flex: 1,
            gap: 8,
        },
        fileBadges: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
        },
        fileBadge: {
            borderWidth: 1,
            borderColor: theme.muted,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 20,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
        },
        fileBadgeText: {
            fontSize: 12,
            color: theme.foreground,
            fontWeight: '500',
        },
        fileName: {
            color: theme.foreground,
            fontWeight: '600' as const,
            fontFamily: 'monospace',
        },
        filePath: {
            color: theme.mutedForeground,
            fontSize: 12,
            fontFamily: 'monospace',
        },
        copyButton: {
            padding: 8,
            borderRadius: 8,
            backgroundColor: theme.muted,
        },
        copiedButton: {
            backgroundColor: theme.secondary,
        },
        emptyState: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            gap: 16,
        },
        emptyFilesContainer: {
            justifyContent: 'center',
            alignItems: 'center',
            paddingVertical: 32,
        },
    });

    console.log('🔧 WEB SCRAPE TOOL RECEIVED:', !!toolContent, toolContent?.length || 0);

    if (!toolContent && !isStreaming) {
        console.log('❌ WEB SCRAPE TOOL: NO CONTENT');
        return (
            <View style={styles.container}>
                <View style={styles.emptyState}>
                    <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                        No web scrape data available
                    </Body>
                </View>
            </View>
        );
    }

    const {
        url,
        files,
        isSuccess: actualIsSuccess,
        statusMessage,
        errorMessage
    } = extractWebScrapeData(toolCall, toolContent);

    const domain = url ? formatDomain(url) : 'Unknown';

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

    const copyFilePath = async (filePath: string) => {
        try {
            await Clipboard.setStringAsync(filePath);
            setCopiedFile(filePath);
            setTimeout(() => setCopiedFile(null), 2000);
        } catch {
            Alert.alert('Error', 'Failed to copy file path');
        }
    };

    const handleLinkPress = (url: string) => {
        Linking.openURL(url).catch(console.error);
    };

    const renderLoading = () => (
        <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.secondary} />
            <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                Extracting Content
            </Body>
            <Caption style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                Analyzing and processing {domain}
            </Caption>
            <View style={styles.progressContainer}>
                <View style={[styles.progressBar, { width: `${progress}%` }]} />
            </View>
            <Caption style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                {progress}% complete
            </Caption>
        </View>
    );

    const renderResults = () => (
        <ScrollView style={{ flex: 1 }}>
            {/* URL Section */}
            <View style={styles.section}>
                <View style={styles.sectionTitle}>
                    <Globe size={16} color={theme.foreground} />
                    <Body style={styles.sectionTitleText}>Source URL</Body>
                </View>
                <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() => handleLinkPress(url)}
                >
                    <Card
                        style={{
                            backgroundColor: mutedBg,
                            borderColor: theme.muted,
                        }}
                        bordered
                        elevated={false}
                    >
                        <CardContent style={{ padding: 0 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                                <View style={{ flex: 1 }}>
                                    <Body style={styles.urlText} numberOfLines={2}>{url}</Body>
                                    <Caption style={styles.domainText}>{domain}</Caption>
                                </View>
                                <ExternalLink size={20} color={theme.mutedForeground} />
                            </View>
                        </CardContent>
                    </Card>
                </TouchableOpacity>
            </View>

            {/* Files Section */}
            <View style={styles.section}>
                <View style={styles.filesHeader}>
                    <View style={styles.sectionTitle}>
                        <Zap size={16} color={theme.foreground} />
                        <Body style={styles.sectionTitleText}>Generated Files ({files.length})</Body>
                    </View>
                </View>

                {files.length > 0 ? (
                    <View>
                        {files.map((filePath, index) => {
                            const fileInfo = formatFileInfo(filePath);
                            const isCopied = copiedFile === filePath;

                            return (
                                <Card
                                    key={index}
                                    style={{
                                        backgroundColor: mutedBg,
                                        borderColor: theme.muted,
                                        marginBottom: 8,
                                    }}
                                    bordered
                                    elevated={false}
                                >
                                    <CardContent style={{ padding: 0 }}>
                                        <View style={styles.fileItemHeader}>
                                            <View style={styles.fileIcon}>
                                                <FileText size={20} color={theme.foreground} />
                                            </View>

                                            <View style={styles.fileDetails}>
                                                <View style={styles.fileBadges}>
                                                    <View style={styles.fileBadge}>
                                                        <Body style={styles.fileBadgeText}>JSON</Body>
                                                    </View>
                                                    {fileInfo.timestamp && (
                                                        <View style={styles.fileBadge}>
                                                            <Calendar size={12} color={theme.foreground} />
                                                            <Body style={styles.fileBadgeText}>
                                                                {fileInfo.timestamp.replace('_', ' ')}
                                                            </Body>
                                                        </View>
                                                    )}
                                                </View>

                                                <Body style={styles.fileName}>{fileInfo.fileName}</Body>
                                                <Caption style={styles.filePath} numberOfLines={1}>
                                                    {fileInfo.fullPath}
                                                </Caption>
                                            </View>

                                            <TouchableOpacity
                                                style={[styles.copyButton, isCopied && styles.copiedButton]}
                                                onPress={() => copyFilePath(filePath)}
                                                activeOpacity={0.7}
                                            >
                                                {isCopied ? (
                                                    <Check size={16} color={theme.secondary} />
                                                ) : (
                                                    <Copy size={16} color={theme.foreground} />
                                                )}
                                            </TouchableOpacity>
                                        </View>
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </View>
                ) : (
                    <View style={styles.emptyFilesContainer}>
                        <FileText size={32} color={theme.mutedForeground} />
                        <Body style={{ color: theme.mutedForeground, textAlign: 'center', marginTop: 8 }}>
                            No files generated
                        </Body>
                    </View>
                )}
            </View>
        </ScrollView>
    );

    const renderEmpty = () => (
        <View style={styles.emptyState}>
            <Globe size={48} color={theme.mutedForeground} />
            <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                No URL Detected
            </Body>
            <Caption style={{ color: theme.mutedForeground, textAlign: 'center', marginTop: 8 }}>
                Unable to extract a valid URL from the scraping request
            </Caption>
        </View>
    );

    return (
        <View style={styles.container}>
            {isStreaming ? renderLoading() :
                url ? renderResults() : renderEmpty()}
        </View>
    );
}; 