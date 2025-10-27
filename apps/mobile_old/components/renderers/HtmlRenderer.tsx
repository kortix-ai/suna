import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Dimensions, Linking, Text, TouchableOpacity, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Colors } from '../../constants/Colors';
import { useColorScheme } from '../../hooks/useColorScheme';
import { CodeRenderer } from './CodeRenderer';

interface HtmlRendererProps {
    content: string;
    previewUrl?: string;
    style?: any;
    disableToggleButtons?: boolean;
}

export function HtmlRenderer({ content, previewUrl, style, disableToggleButtons = true }: HtmlRendererProps) {
    const colorScheme = useColorScheme();
    const isDark = colorScheme === 'dark';
    const theme = Colors[colorScheme ?? 'light'];
    const { width, height } = Dimensions.get('window');

    // Always default to 'preview' mode
    const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');

    if (!content) {
        return (
            <View style={[{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                backgroundColor: theme.background,
                padding: 20
            }, style]}>
                <Text style={{
                    fontSize: 16,
                    color: theme.foreground,
                    opacity: 0.7
                }}>
                    No HTML content to display
                </Text>
            </View>
        );
    }


    const renderToggleButtons = () => (
        <View style={{
            position: 'absolute',
            top: 12,
            left: 12,
            zIndex: 10,
            flexDirection: 'row',
            backgroundColor: isDark ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.8)',
            borderRadius: 8,
            padding: 4,
            elevation: 3,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.25,
            shadowRadius: 3.84,
        }}>
            <TouchableOpacity
                onPress={() => setViewMode('preview')}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 6,
                    backgroundColor: viewMode === 'preview' ?
                        (isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)') :
                        'transparent',
                }}
            >
                <Ionicons
                    name="eye-outline"
                    size={16}
                    color={theme.foreground}
                    style={{ marginRight: 6 }}
                />
                <Text style={{
                    fontSize: 14,
                    color: theme.foreground,
                    fontWeight: viewMode === 'preview' ? '600' : '400'
                }}>
                    Preview
                </Text>
            </TouchableOpacity>

            <TouchableOpacity
                onPress={() => setViewMode('code')}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 6,
                    backgroundColor: viewMode === 'code' ?
                        (isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)') :
                        'transparent',
                }}
            >
                <Ionicons
                    name="code-slash-outline"
                    size={16}
                    color={theme.foreground}
                    style={{ marginRight: 6 }}
                />
                <Text style={{
                    fontSize: 14,
                    color: theme.foreground,
                    fontWeight: viewMode === 'code' ? '600' : '400'
                }}>
                    Code
                </Text>
            </TouchableOpacity>
            {previewUrl && (
                <TouchableOpacity
                    onPress={() => Linking.openURL(previewUrl)}
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 6,
                        marginLeft: 4,
                    }}
                >
                    <Ionicons
                        name="open-outline"
                        size={16}
                        color={theme.foreground}
                    />
                </TouchableOpacity>
            )}

        </View>
    );

    return (
        <View style={[{ backgroundColor: theme.background }, style]}>
            {/* Toggle buttons */}
            {!disableToggleButtons && renderToggleButtons()}
            {/* Content area */}
            <View style={{ flex: 1 }}>
                {viewMode === 'preview' ? (
                    <WebView
                        source={{ html: content }}
                        style={{
                        }}
                        showsVerticalScrollIndicator={true}
                        showsHorizontalScrollIndicator={false}
                        scalesPageToFit={true}
                        originWhitelist={['*']}
                        mixedContentMode="compatibility"
                        javaScriptEnabled={true}
                        domStorageEnabled={true}
                        startInLoadingState={true}
                        renderLoading={() => (
                            <View style={{
                                justifyContent: 'center',
                                alignItems: 'center',
                                backgroundColor: theme.background
                            }}>
                                <Text style={{
                                    fontSize: 16,
                                    color: theme.foreground,
                                    opacity: 0.7
                                }}>
                                    Loading HTML...
                                </Text>
                            </View>
                        )}
                        onError={(error) => {
                            console.error('WebView error:', error);
                        }}
                        onHttpError={(error) => {
                            console.error('WebView HTTP error:', error);
                        }}
                        onLoad={() => {
                            // Optional: Handle successful load
                        }}
                    />
                ) : (
                    <CodeRenderer
                        content={content}
                        language="html"
                        showLineNumbers={true}
                        style={{ flex: 1 }}
                    />
                )}
            </View>
        </View>
    );
} 