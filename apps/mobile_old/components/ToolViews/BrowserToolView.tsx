import { useTheme } from '@/hooks/useThemeColor';
import { AlertTriangle, Globe, Monitor } from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Caption } from '../Typography';
import { ToolViewProps } from './ToolViewRegistry';

export interface BrowserToolViewProps extends ToolViewProps {
    assistantContent?: string;
    toolContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
    project?: any;
    agentStatus?: 'idle' | 'running';
    currentIndex?: number;
    totalCalls?: number;
    browserState?: any;
}

// Type definitions for parsed JSON data
interface ToolResultData {
    url?: string;
    image_url?: string;
    message_id?: string;
    [key: string]: any;
}

interface ParsedContent {
    content?: string;
    tool_execution?: {
        result?: {
            output?: {
                image_url?: string;
                [key: string]: any;
            };
        };
    };
    [key: string]: any;
}

interface BrowserStateContent {
    screenshot_base64?: string;
    image_url?: string;
    [key: string]: any;
}

const safeJsonParse = <T,>(jsonString: string | undefined | null, fallback: T): T => {
    if (!jsonString) return fallback;
    try {
        const parsed = JSON.parse(jsonString);
        if (typeof parsed === 'string' && (parsed.startsWith('{') || parsed.startsWith('['))) {
            return JSON.parse(parsed) as T;
        }
        return parsed as T;
    } catch {
        return fallback;
    }
};

const extractBrowserUrl = (content: string | undefined): string | null => {
    if (!content) return null;

    const urlMatch = content.match(/(?:url|URL)["']?\s*[:=]\s*["']?([^"'\s,}]+)/);
    if (urlMatch) return urlMatch[1];

    const httpMatch = content.match(/https?:\/\/[^\s"']+/);
    if (httpMatch) return httpMatch[0];

    return null;
};

const extractBrowserOperation = (toolName: string | undefined): string => {
    if (!toolName) return 'Browser Action';

    const operations: { [key: string]: string } = {
        'browser-navigate-to': 'Navigate',
        'browser-click-element': 'Click Element',
        'browser-input-text': 'Input Text',
        'browser-scroll-down': 'Scroll Down',
        'browser-scroll-up': 'Scroll Up',
        'browser-go-back': 'Go Back',
        'browser-wait': 'Wait',
        'browser-send-keys': 'Send Keys',
        'browser-switch-tab': 'Switch Tab',
        'browser-close-tab': 'Close Tab',
        'browser-scroll-to-text': 'Scroll to Text',
        'browser-get-dropdown-options': 'Get Dropdown Options',
        'browser-select-dropdown-option': 'Select Option',
        'browser-drag-drop': 'Drag & Drop',
        'browser-click-coordinates': 'Click Coordinates',
    };

    return operations[toolName] || 'Browser Action';
};

export const BrowserToolView: React.FC<BrowserToolViewProps> = ({
    name = 'browser-operation',
    toolCall,
    browserState,
    isStreaming = false,
    project,
    agentStatus = 'idle',
    currentIndex = 0,
    totalCalls = 1,
    ...props
}) => {
    console.log('🌐 BROWSER TOOL:', name, 'HAS BROWSER STATE:', !!browserState);

    const theme = useTheme();
    const [imageLoading, setImageLoading] = useState(true);
    const [imageError, setImageError] = useState(false);

    const operation = extractBrowserOperation(name);
    const isRunning = isStreaming || agentStatus === 'running';

    // Extract data from browserState prop (passed from ui-store)
    const url = browserState?.url || toolCall?.arguments?.url;
    const screenshotBase64 = browserState?.screenshot_base64;
    const screenshotUrl = browserState?.image_url;

    console.log('🖼️ BROWSER DATA:', { url, hasScreenshot: !!screenshotBase64, hasImageUrl: !!screenshotUrl });

    // VNC preview URL
    const vncPreviewUrl = useMemo(() => {
        if (!project?.sandbox?.vnc_preview) return null;
        return `${project.sandbox.vnc_preview}/vnc_lite.html?password=${project?.sandbox?.pass}&autoconnect=true&scale=local&width=1024&height=768`;
    }, [project]);

    // Reset image loading state when screenshot changes
    useEffect(() => {
        if (screenshotUrl || screenshotBase64) {
            setImageLoading(true);
            setImageError(false);
        }
    }, [screenshotUrl, screenshotBase64]);

    const handleImageLoad = () => {
        setImageLoading(false);
        setImageError(false);
    };

    const handleImageError = () => {
        setImageLoading(false);
        setImageError(true);
    };

    const renderScreenshot = () => {
        const imageSource = screenshotUrl
            ? { uri: screenshotUrl }
            : screenshotBase64
                ? { uri: `data:image/png;base64,${screenshotBase64}` }
                : null;

        if (!imageSource) return null;

        return (
            <View style={styles.screenshotContainer}>
                <View style={styles.imageContainer}>
                    {imageLoading && (
                        <View style={styles.imageLoading}>
                            <ActivityIndicator size="large" color={theme.primary} />
                        </View>
                    )}
                    {imageError ? (
                        <View style={styles.imageError}>
                            <AlertTriangle size={24} color={theme.mutedForeground} />
                            <Caption style={[styles.errorText, { color: theme.mutedForeground }]}>
                                Failed to load screenshot
                            </Caption>
                        </View>
                    ) : (
                        <Image
                            source={imageSource}
                            style={styles.screenshot}
                            onLoad={handleImageLoad}
                            onError={handleImageError}
                            resizeMode="contain"
                        />
                    )}
                </View>

                {/* URL info */}
                {url && (
                    <View style={styles.urlContainer}>
                        <Globe size={14} color={theme.mutedForeground} />
                        <Caption style={[styles.urlText, { color: theme.mutedForeground }]} numberOfLines={1}>
                            {url}
                        </Caption>
                    </View>
                )}

                {/* VNC Preview Button */}
                {vncPreviewUrl && (
                    <TouchableOpacity
                        style={[styles.vncButton, { backgroundColor: theme.secondary }]}
                        onPress={() => {
                            // Handle VNC preview navigation
                            console.log('VNC Preview:', vncPreviewUrl);
                        }}
                    >
                        <Monitor size={14} color={theme.secondaryForeground} />
                        <Caption style={[styles.vncButtonText, { color: theme.secondaryForeground }]}>
                            View Live Browser
                        </Caption>
                    </TouchableOpacity>
                )}
            </View>
        );
    };

    const renderContent = () => {
        // Loading state
        if (isRunning) {
            return (
                <View style={styles.loadingContainer}>
                    <View style={styles.loadingIconContainer}>
                        <ActivityIndicator size="large" color={theme.primary} />
                    </View>
                    <Text style={styles.loadingTitle}>
                        {operation} in progress
                    </Text>
                    <Text style={styles.loadingSubtitle}>
                        {url || 'Executing browser action...'}
                    </Text>
                </View>
            );
        }

        // Show screenshot if available
        if (screenshotUrl || screenshotBase64) {
            return renderScreenshot();
        }

        // Empty state
        return (
            <View style={styles.emptyContainer}>
                <View style={styles.emptyIconContainer}>
                    <Monitor size={32} color={theme.mutedForeground} />
                </View>
                <Text style={[styles.emptyTitle, { color: theme.mutedForeground }]}>
                    No Browser State Available
                </Text>
                <Text style={[styles.emptySubtitle, { color: theme.mutedForeground }]}>
                    Browser state image not found for this action
                </Text>
                {url && (
                    <View style={styles.urlContainer}>
                        <Globe size={14} color={theme.mutedForeground} />
                        <Caption style={[styles.urlText, { color: theme.mutedForeground }]} numberOfLines={1}>
                            {url}
                        </Caption>
                    </View>
                )}
            </View>
        );
    };

    return (
        <View style={[styles.container, { backgroundColor: theme.background }]}>
            {renderContent()}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 12,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: 200,
    },
    loadingIconContainer: {
        marginBottom: 16,
    },
    loadingTitle: {
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 8,
        textAlign: 'center',
    },
    loadingSubtitle: {
        fontSize: 14,
        textAlign: 'center',
        opacity: 0.7,
    },
    screenshotContainer: {
        flex: 1,
    },
    imageContainer: {
        flex: 1,
        backgroundColor: '#f5f5f5',
        borderRadius: 8,
        overflow: 'hidden',
        position: 'relative',
        minHeight: 200,
    },
    screenshot: {
        width: '100%',
        height: '100%',
    },
    imageLoading: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.1)',
    },
    imageError: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    errorText: {
        marginTop: 8,
        textAlign: 'center',
    },
    urlContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: 'rgba(0, 0, 0, 0.05)',
        borderRadius: 6,
    },
    urlText: {
        flex: 1,
        marginLeft: 8,
    },
    vncButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 12,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 6,
    },
    vncButtonText: {
        marginLeft: 8,
        fontSize: 12,
        fontWeight: '500',
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: 200,
    },
    emptyIconContainer: {
        marginBottom: 16,
    },
    emptyTitle: {
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 8,
        textAlign: 'center',
    },
    emptySubtitle: {
        fontSize: 14,
        textAlign: 'center',
        opacity: 0.7,
        marginBottom: 16,
    },
}); 