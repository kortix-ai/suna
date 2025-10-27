import { useTheme } from '@/hooks/useThemeColor';
import {
    AlertTriangle,
    Briefcase,
    ChevronRight,
    Code,
    Database,
    Home,
    MessageCircle,
    Settings,
    ShoppingBag,
    TrendingUp,
    Users
} from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Body, Caption } from '../Typography';
import { Card, CardContent } from '../ui/Card';
import { ToolViewProps } from './ToolViewRegistry';

interface ExecuteDataProviderCallToolViewProps extends ToolViewProps {
    assistantContent?: string;
    toolContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
    toolCall?: any;
}

const PROVIDER_CONFIG = {
    'linkedin': {
        name: 'LinkedIn Data Provider',
        icon: Users,
        color: '#0077B5',
    },
    'twitter': {
        name: 'Twitter Data Provider',
        icon: MessageCircle,
        color: '#1DA1F2',
    },
    'zillow': {
        name: 'Zillow Data Provider',
        icon: Home,
        color: '#10B981',
    },
    'amazon': {
        name: 'Amazon Data Provider',
        icon: ShoppingBag,
        color: '#F59E0B',
    },
    'yahoo_finance': {
        name: 'Yahoo Finance Data Provider',
        icon: TrendingUp,
        color: '#8B5CF6',
    },
    'active_jobs': {
        name: 'Active Jobs Data Provider',
        icon: Briefcase,
        color: '#6366F1',
    }
};

const extractDataProviderCallData = (toolCall?: any, toolContent?: string) => {
    let serviceName = '';
    let route = '';
    let payload: any = {};
    let output = '';
    let isSuccess = true;
    let errorMessage = '';

    // Extract from tool call parameters
    if (toolCall?.parameters) {
        serviceName = toolCall.parameters.service_name || toolCall.parameters.serviceName || '';
        route = toolCall.parameters.route || '';
        payload = toolCall.parameters.payload || {};
        output = toolCall.parameters.output || '';
    }

    // Parse tool content if available
    if (toolContent) {
        try {
            const parsed = JSON.parse(toolContent);

            if (parsed.tool_execution) {
                const toolExecution = parsed.tool_execution;

                // Extract arguments
                if (toolExecution.arguments) {
                    serviceName = toolExecution.arguments.service_name || toolExecution.arguments.serviceName || serviceName;
                    route = toolExecution.arguments.route || route;
                    payload = toolExecution.arguments.payload || payload;
                    output = toolExecution.arguments.output || output;
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
                        output = result.error;
                    }

                    if (result.output) {
                        if (typeof result.output === 'string') {
                            output = result.output;
                        } else {
                            output = JSON.stringify(result.output, null, 2);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error parsing tool content:', error);
        }
    }

    return {
        serviceName,
        route,
        payload,
        output,
        isSuccess,
        errorMessage
    };
};

export function ExecuteDataProviderCallToolView({
    name = 'execute-data-provider-call',
    toolCall,
    toolContent,
    isStreaming = false,
    isSuccess = true,
    ...props
}: ExecuteDataProviderCallToolViewProps) {
    const theme = useTheme();
    const [showRawJSON, setShowRawJSON] = useState(false);

    // Convert color-mix(in oklab, var(--muted) 20%, transparent) to hex
    const mutedBg = theme.muted === '#e8e8e8' ? '#e8e8e833' : '#30303033';

    const extractedData = extractDataProviderCallData(toolCall, toolContent);
    const { serviceName, route, payload, output, isSuccess: actualIsSuccess, errorMessage } = extractedData;

    const providerKey = serviceName?.toLowerCase() as keyof typeof PROVIDER_CONFIG;
    const providerConfig = providerKey && PROVIDER_CONFIG[providerKey]
        ? PROVIDER_CONFIG[providerKey]
        : PROVIDER_CONFIG['linkedin'];

    const IconComponent = providerConfig.icon;
    const hasPayload = payload && Object.keys(payload).length > 0;

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
        providerHeader: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
        },
        providerIcon: {
            width: 48,
            height: 48,
            borderRadius: 12,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: providerConfig.color,
        },
        providerInfo: {
            flex: 1,
        },
        providerName: {
            color: theme.foreground,
            fontWeight: '600' as const,
            marginBottom: 4,
        },
        providerService: {
            color: theme.mutedForeground,
        },
        routeBadge: {
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 12,
            backgroundColor: theme.muted,
            borderWidth: 1,
            borderColor: theme.muted,
        },
        routeText: {
            fontSize: 12,
            fontFamily: 'monospace',
            color: theme.foreground,
        },
        parameterItem: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
        },
        parameterLeft: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            flex: 1,
        },
        parameterDot: {
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: theme.muted,
        },
        parameterKey: {
            fontFamily: 'monospace',
            fontWeight: '500' as const,
            color: theme.foreground,
        },
        parameterValue: {
            color: theme.mutedForeground,
            fontFamily: 'monospace',
            fontSize: 12,
            maxWidth: 120,
        },
        jsonToggle: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginTop: 8,
        },
        jsonToggleText: {
            color: theme.foreground,
            fontWeight: '500' as const,
        },
        jsonContainer: {
            marginTop: 8,
            padding: 16,
            backgroundColor: theme.background === '#ffffff' ? '#1e293b' : '#0f172a',
            borderRadius: 8,
        },
        jsonText: {
            fontSize: 12,
            fontFamily: 'monospace',
            color: '#22c55e',
            lineHeight: 16,
        },
        errorText: {
            color: theme.destructive,
            fontFamily: 'monospace',
            fontSize: 12,
            lineHeight: 16,
        },
        emptyDescription: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
        },
    });

    const renderLoadingState = () => (
        <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.secondary} />
            <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                Executing call...
            </Body>
            <Caption style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                Calling {serviceName || 'data provider'}
            </Caption>
        </View>
    );

    const renderContent = () => {
        return (
            <ScrollView style={{ flex: 1 }}>
                {/* Provider Section */}
                <View style={styles.section}>
                    <View style={styles.sectionTitle}>
                        <Database size={16} color={theme.foreground} />
                        <Body style={styles.sectionTitleText}>Data Provider Call</Body>
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
                            <View style={styles.providerHeader}>
                                <View style={styles.providerIcon}>
                                    <IconComponent size={24} color="#ffffff" />
                                </View>

                                <View style={styles.providerInfo}>
                                    <Body style={styles.providerName}>
                                        {providerConfig.name}
                                    </Body>
                                    {serviceName && (
                                        <Caption style={styles.providerService}>
                                            Service: {serviceName}
                                        </Caption>
                                    )}
                                </View>

                                {route && (
                                    <View style={styles.routeBadge}>
                                        <Caption style={styles.routeText}>{route}</Caption>
                                    </View>
                                )}
                            </View>
                        </CardContent>
                    </Card>
                </View>

                {/* Error Section */}
                {output && !actualIsSuccess && (
                    <View style={styles.section}>
                        <View style={styles.sectionTitle}>
                            <AlertTriangle size={16} color={theme.destructive} />
                            <Body style={[styles.sectionTitleText, { color: theme.destructive }]}>
                                Execution Failed
                            </Body>
                        </View>
                        <Card
                            style={{
                                backgroundColor: mutedBg,
                                borderColor: theme.destructive,
                            }}
                            bordered
                            elevated={false}
                        >
                            <CardContent style={{ padding: 0 }}>
                                <Body style={styles.errorText}>{output}</Body>
                            </CardContent>
                        </Card>
                    </View>
                )}

                {/* Parameters Section */}
                {hasPayload && (
                    <View style={styles.section}>
                        <View style={styles.sectionTitle}>
                            <Settings size={16} color={theme.foreground} />
                            <Body style={styles.sectionTitleText}>Call Parameters</Body>
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
                                {Object.entries(payload).map(([key, value]) => (
                                    <View key={key} style={styles.parameterItem}>
                                        <View style={styles.parameterLeft}>
                                            <View style={styles.parameterDot} />
                                            <Body style={styles.parameterKey}>{key}</Body>
                                        </View>
                                        <Caption style={styles.parameterValue} numberOfLines={1}>
                                            {typeof value === 'string' ? `"${value}"` : String(value)}
                                        </Caption>
                                    </View>
                                ))}

                                <TouchableOpacity
                                    style={styles.jsonToggle}
                                    onPress={() => setShowRawJSON(!showRawJSON)}
                                >
                                    <Code size={16} color={theme.foreground} />
                                    <Body style={styles.jsonToggleText}>Raw JSON</Body>
                                    <ChevronRight
                                        size={12}
                                        color={theme.mutedForeground}
                                        style={{
                                            transform: [{ rotate: showRawJSON ? '90deg' : '0deg' }]
                                        }}
                                    />
                                </TouchableOpacity>

                                {showRawJSON && (
                                    <View style={styles.jsonContainer}>
                                        <Body style={styles.jsonText}>
                                            {JSON.stringify(payload, null, 2)}
                                        </Body>
                                    </View>
                                )}
                            </CardContent>
                        </Card>
                    </View>
                )}

                {/* Empty State */}
                {!serviceName && !route && !hasPayload && (
                    <View style={styles.emptyState}>
                        <Database size={48} color={theme.mutedForeground} />
                        <View style={styles.emptyDescription}>
                            <ActivityIndicator size="small" color={theme.mutedForeground} />
                            <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                                Will be populated when the call is executed...
                            </Body>
                        </View>
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