import { useTheme } from '@/hooks/useThemeColor';
import { Globe, Image as ImageIcon, Search } from 'lucide-react-native';
import React from 'react';
import { ActivityIndicator, Image, Linking, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Body, Caption } from '../Typography';
import { Card, CardContent } from '../ui/Card';
import { ToolViewProps } from './ToolViewRegistry';

export interface WebSearchToolViewProps extends ToolViewProps {
    assistantContent?: string;
    toolContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
    messages?: any[];
}

interface SearchResult {
    title: string;
    url: string;
    snippet?: string;
}

const extractWebSearchData = (toolCall?: any, toolContent?: string) => {
    let query = '';
    let searchResults: SearchResult[] = [];
    let images: string[] = [];
    let answer = '';
    let isSuccess = true;
    let errorMessage = '';

    // Extract from tool call parameters
    if (toolCall?.parameters) {
        query = toolCall.parameters.query ||
            toolCall.parameters.search_term || '';
    }

    // Parse tool content if available
    if (toolContent) {
        try {
            const parsed = JSON.parse(toolContent);

            if (parsed.tool_execution) {
                const toolExecution = parsed.tool_execution;

                // Extract arguments
                if (toolExecution.arguments) {
                    query = toolExecution.arguments.query ||
                        toolExecution.arguments.search_term || query;
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

                        // Query from output
                        if (output.query) {
                            query = output.query;
                        }

                        // Search results
                        if (output.results && Array.isArray(output.results)) {
                            searchResults = output.results.map((result: any) => ({
                                title: result.title || '',
                                url: result.url || result.link || '',
                                snippet: result.snippet || result.description || result.content || ''
                            }));
                        }

                        // Images
                        if (output.images && Array.isArray(output.images)) {
                            images = output.images;
                        }

                        // Answer
                        if (output.answer) {
                            answer = output.answer;
                        }
                    }
                }
            }
        } catch (e) {
            // If parsing fails, mark as error
            isSuccess = false;
            errorMessage = 'Failed to parse search results';
        }
    }

    return {
        query,
        searchResults,
        images,
        answer,
        isSuccess,
        errorMessage
    };
};

export const WebSearchToolView: React.FC<WebSearchToolViewProps> = ({
    toolCall,
    toolContent,
    isStreaming = false,
    isSuccess = true,
    ...props
}) => {
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
        imagesGrid: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
        },
        imageContainer: {
            width: 100,
            height: 100,
            borderRadius: 12,
            overflow: 'hidden',
        },
        imageStyle: {
            width: '100%',
            height: '100%',
        },
        resultTitle: {
            color: linkColor,
            marginBottom: 4,
            fontWeight: '600' as const,
        },
        resultUrl: {
            color: linkColor,
            fontSize: 12,
            marginBottom: 8,
        },
        resultSnippet: {
            color: theme.foreground,
            fontSize: 13,
            lineHeight: 18,
        },
    });

    console.log('🔍 WEB SEARCH TOOL RECEIVED:', !!toolContent, toolContent?.length || 0);

    if (!toolContent && !isStreaming) {
        console.log('❌ WEB SEARCH TOOL: NO CONTENT');
        return (
            <View style={styles.container}>
                <View style={styles.emptyState}>
                    <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                        No search data available
                    </Body>
                </View>
            </View>
        );
    }

    const {
        query,
        searchResults,
        images,
        answer,
        isSuccess: actualIsSuccess,
        errorMessage
    } = extractWebSearchData(toolCall, toolContent);

    const handleLinkPress = (url: string) => {
        Linking.openURL(url).catch(console.error);
    };

    const renderLoading = () => (
        <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.secondary} />
            <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                Searching the web...
            </Body>
        </View>
    );

    const renderResults = () => (
        <ScrollView style={{ flex: 1 }}>
            {images.length > 0 && (
                <View style={styles.section}>
                    <View style={styles.sectionTitle}>
                        <ImageIcon size={16} color={theme.foreground} />
                        <Body style={styles.sectionTitleText}>Images ({images.length})</Body>
                    </View>
                    <View style={styles.imagesGrid}>
                        {images.slice(0, 6).map((imageUrl, index) => (
                            <TouchableOpacity
                                key={index}
                                activeOpacity={0.7}
                                onPress={() => handleLinkPress(imageUrl)}
                            >
                                <Card
                                    style={{
                                        ...styles.imageContainer,
                                        backgroundColor: mutedBg,
                                        borderColor: theme.muted,
                                        borderRadius: 20,
                                        padding: 0,
                                    }}
                                    bordered
                                    elevated={false}
                                >
                                    <Image
                                        source={{ uri: imageUrl }}
                                        style={styles.imageStyle}
                                        resizeMode="cover"
                                    />
                                </Card>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            )}

            {searchResults.length > 0 && (
                <View style={styles.section}>
                    <View style={styles.sectionTitle}>
                        <Globe size={16} color={theme.foreground} />
                        <Body style={styles.sectionTitleText}>Results ({searchResults.length})</Body>
                    </View>
                    {searchResults.map((result, index) => (
                        <TouchableOpacity
                            key={index}
                            activeOpacity={0.7}
                            onPress={() => handleLinkPress(result.url)}
                        >
                            <Card
                                style={{
                                    backgroundColor: mutedBg,
                                    borderColor: theme.muted,
                                    marginBottom: 8,
                                }}
                                bordered
                                elevated={false}
                            >
                                <CardContent style={{ padding: 0 }}>
                                    <Body style={styles.resultTitle} numberOfLines={2}>
                                        {result.title}
                                    </Body>
                                    <Caption style={styles.resultUrl} numberOfLines={1}>
                                        {result.url}
                                    </Caption>
                                    {result.snippet && (
                                        <Body style={styles.resultSnippet} numberOfLines={3}>
                                            {result.snippet}
                                        </Body>
                                    )}
                                </CardContent>
                            </Card>
                        </TouchableOpacity>
                    ))}
                </View>
            )}
        </ScrollView>
    );

    const renderEmpty = () => (
        <View style={styles.emptyState}>
            <Search size={48} color={theme.mutedForeground} />
            <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                No search results found
            </Body>
        </View>
    );

    return (
        <View style={styles.container}>
            {isStreaming ? renderLoading() :
                searchResults.length > 0 || images.length > 0 ? renderResults() : renderEmpty()}
        </View>
    );
}; 