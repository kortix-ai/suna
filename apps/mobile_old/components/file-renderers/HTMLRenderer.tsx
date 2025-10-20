import { useTheme } from '@/hooks/useThemeColor';
import { ExternalLink } from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { WebView } from 'react-native-webview';

interface HTMLRendererProps {
    filepath: string;
    sandboxId?: string;
    filename: string;
    uploadedBlob?: Blob;
    onExternalOpen?: () => void;
}

/**
 * Construct HTML preview URL from sandbox URL
 * Mimics the frontend constructHtmlPreviewUrl function
 */
function constructHtmlPreviewUrl(sandboxUrl: string, filePath: string): string {
    // Remove /workspace/ prefix if present
    const cleanPath = filePath.replace(/^\/workspace\//, '');

    // Split into segments and encode each segment
    const segments = cleanPath.split('/').map(segment => encodeURIComponent(segment));

    // Join back and construct final URL
    const encodedPath = segments.join('/');
    return `${sandboxUrl}/${encodedPath}`;
}

export const HTMLRenderer: React.FC<HTMLRendererProps> = ({
    filepath,
    sandboxId,
    filename,
    uploadedBlob,
    onExternalOpen
}) => {
    const theme = useTheme();

    // HTML content state for local files
    const [htmlContent, setHtmlContent] = useState<string | null>(null);
    const [htmlLoading, setHtmlLoading] = useState(false);
    const [htmlError, setHtmlError] = useState<string | null>(null);

    // Load HTML content for local files
    useEffect(() => {
        if (!uploadedBlob || sandboxId) return;

        setHtmlLoading(true);
        setHtmlError(null);

        uploadedBlob.text()
            .then(content => {
                setHtmlContent(content);
                setHtmlLoading(false);
            })
            .catch(error => {
                console.error('Error reading HTML content:', error);
                setHtmlError('Failed to read HTML content');
                setHtmlLoading(false);
            });
    }, [uploadedBlob, sandboxId]);

    // Construct proper HTML preview URL for sandbox files
    const htmlPreviewUrl = useMemo(() => {
        if (sandboxId) {
            // Construct direct sandbox URL like: https://8080-{sandboxId}.h1111.daytona.work
            // This matches the pattern from the user's frontend example
            const sandboxUrl = `https://8080-${sandboxId}.h1111.daytona.work`;
            return constructHtmlPreviewUrl(sandboxUrl, filepath);
        }
        return null;
    }, [sandboxId, filepath]);

    console.log(`[HTMLRenderer] ${filename} - sandboxId: ${sandboxId || 'none'}, htmlPreviewUrl: ${htmlPreviewUrl || 'none'}`);

    const handleExternalOpen = () => {
        onExternalOpen?.();
    };

    // Loading state
    if (htmlLoading || (sandboxId && !htmlPreviewUrl)) {
        return (
            <View style={styles.container}>
                {/* Header */}
                <View style={[styles.header, { backgroundColor: theme.background }]}>
                    <Text style={[styles.filename, { color: theme.foreground }]} numberOfLines={1}>
                        {filename}
                    </Text>
                    <TouchableOpacity
                        style={[styles.externalButton, { backgroundColor: theme.sidebar }]}
                        onPress={handleExternalOpen}
                    >
                        <ExternalLink size={14} color={theme.mutedForeground} />
                    </TouchableOpacity>
                </View>

                {/* Loading Content */}
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="small" color={theme.mutedForeground} />
                    <Text style={[styles.loadingText, { color: theme.mutedForeground }]}>
                        Loading HTML...
                    </Text>
                </View>
            </View>
        );
    }

    // Error state
    if (htmlError) {
        return (
            <View style={styles.container}>
                {/* Header */}
                <View style={[styles.header, { backgroundColor: theme.background }]}>
                    <Text style={[styles.filename, { color: theme.foreground }]} numberOfLines={1}>
                        {filename}
                    </Text>
                    <TouchableOpacity
                        style={[styles.externalButton, { backgroundColor: theme.sidebar }]}
                        onPress={handleExternalOpen}
                    >
                        <ExternalLink size={14} color={theme.mutedForeground} />
                    </TouchableOpacity>
                </View>

                {/* Error Content */}
                <View style={styles.errorContainer}>
                    <Text style={[styles.errorText, { color: theme.destructive }]}>
                        Failed to load HTML
                    </Text>
                    <Text style={[styles.errorSubtext, { color: theme.mutedForeground }]}>
                        Click header to open externally
                    </Text>
                </View>
            </View>
        );
    }

    // Success state - render HTML
    const webViewSource = htmlPreviewUrl
        ? { uri: htmlPreviewUrl }
        : htmlContent
            ? { html: htmlContent }
            : null;

    if (!webViewSource) {
        return (
            <View style={styles.container}>
                {/* Header */}
                <View style={[styles.header, { backgroundColor: theme.background }]}>
                    <Text style={[styles.filename, { color: theme.foreground }]} numberOfLines={1}>
                        {filename}
                    </Text>
                    <TouchableOpacity
                        style={[styles.externalButton, { backgroundColor: theme.sidebar }]}
                        onPress={handleExternalOpen}
                    >
                        <ExternalLink size={14} color={theme.mutedForeground} />
                    </TouchableOpacity>
                </View>

                {/* Empty Content */}
                <View style={styles.emptyContainer}>
                    <Text style={[styles.emptyText, { color: theme.mutedForeground }]}>
                        Preview available
                    </Text>
                    <Text style={[styles.emptySubtext, { color: theme.mutedForeground }]}>
                        Click header to open externally
                    </Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {/* Header */}
            <View style={[styles.header, { backgroundColor: theme.background }]}>
                <Text style={[styles.filename, { color: theme.foreground }]} numberOfLines={1}>
                    {filename}
                </Text>
                <TouchableOpacity
                    style={[styles.externalButton, { backgroundColor: theme.sidebar }]}
                    onPress={handleExternalOpen}
                >
                    <ExternalLink size={14} color={theme.mutedForeground} />
                </TouchableOpacity>
            </View>

            {/* HTML Content */}
            <View style={styles.contentContainer}>
                <WebView
                    source={webViewSource}
                    style={styles.webView}
                    onError={(syntheticEvent) => {
                        const { nativeEvent } = syntheticEvent;
                        console.log('WebView error: ', nativeEvent);
                    }}
                    onLoad={() => {
                        console.log(`[HTMLRenderer] HTML LOADED - ${filename}`);
                        console.log(`[HTMLRenderer] - source: ${htmlPreviewUrl ? 'SANDBOX_URL' : 'LOCAL_CONTENT'}`);
                    }}
                    startInLoadingState={true}
                    renderLoading={() => (
                        <View style={styles.webViewLoading}>
                            <ActivityIndicator size="small" color={theme.mutedForeground} />
                        </View>
                    )}
                />
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        width: '100%',
        height: '100%',
    },
    header: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 40,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 12,
        zIndex: 10,
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    filename: {
        fontSize: 14,
        fontWeight: '500',
        flex: 1,
        marginRight: 8,
    },
    externalButton: {
        width: 28,
        height: 28,
        borderRadius: 14,
        justifyContent: 'center',
        alignItems: 'center',
    },
    contentContainer: {
        flex: 1,
        marginTop: 40, // Space for header
    },
    webView: {
        flex: 1,
        backgroundColor: 'white',
    },
    webViewLoading: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'transparent',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 40,
    },
    loadingText: {
        fontSize: 14,
        marginTop: 8,
    },
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 40,
        paddingHorizontal: 16,
    },
    errorText: {
        fontSize: 14,
        fontWeight: '500',
        marginBottom: 4,
    },
    errorSubtext: {
        fontSize: 12,
        textAlign: 'center',
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 40,
        paddingHorizontal: 16,
    },
    emptyText: {
        fontSize: 14,
        marginBottom: 4,
    },
    emptySubtext: {
        fontSize: 12,
        textAlign: 'center',
    },
}); 