import { useTheme } from '@/hooks/useThemeColor';
import {
    AlertTriangle,
    Briefcase,
    CheckCircle,
    Database,
    Home,
    MessageCircle,
    ShoppingBag,
    TrendingUp,
    Users
} from 'lucide-react-native';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { Body, Caption } from '../Typography';
import { Card, CardContent } from '../ui/Card';
import { ToolViewProps } from './ToolViewRegistry';

interface DataProviderEndpointsToolViewProps extends ToolViewProps {
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

const extractDataProviderEndpointsData = (toolCall?: any, toolContent?: string) => {
    let serviceName = '';
    let endpoints: any = {};
    let isSuccess = true;
    let errorMessage = '';

    // Extract from tool call parameters
    if (toolCall?.parameters) {
        serviceName = toolCall.parameters.service_name || toolCall.parameters.serviceName || '';
        endpoints = toolCall.parameters.endpoints || {};
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
                    endpoints = toolExecution.arguments.endpoints || endpoints;
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
                            try {
                                const outputParsed = JSON.parse(result.output);
                                serviceName = outputParsed.service_name || outputParsed.serviceName || serviceName;
                                endpoints = outputParsed.endpoints || endpoints;
                            } catch {
                                // If not JSON, treat as service name
                                serviceName = result.output;
                            }
                        } else {
                            serviceName = result.output.service_name || result.output.serviceName || serviceName;
                            endpoints = result.output.endpoints || endpoints;
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
        endpoints,
        isSuccess,
        errorMessage
    };
};

export function DataProviderEndpointsToolView({
    name = 'get-data-provider-endpoints',
    toolCall,
    toolContent,
    isStreaming = false,
    isSuccess = true,
    ...props
}: DataProviderEndpointsToolViewProps) {
    const theme = useTheme();

    // Convert color-mix(in oklab, var(--muted) 20%, transparent) to hex
    const mutedBg = theme.muted === '#e8e8e8' ? '#e8e8e833' : '#30303033';

    const extractedData = extractDataProviderEndpointsData(toolCall, toolContent);
    const { serviceName, endpoints, isSuccess: actualIsSuccess, errorMessage } = extractedData;

    const providerConfig = serviceName && PROVIDER_CONFIG[serviceName as keyof typeof PROVIDER_CONFIG]
        ? PROVIDER_CONFIG[serviceName as keyof typeof PROVIDER_CONFIG]
        : PROVIDER_CONFIG['linkedin'];

    const IconComponent = providerConfig.icon;
    const endpointCount = endpoints && typeof endpoints === 'object' ? Object.keys(endpoints).length : 0;

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
        providerDescription: {
            color: theme.mutedForeground,
        },
        statusBadge: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 12,
            backgroundColor: actualIsSuccess ? theme.secondary : theme.destructive,
            gap: 4,
        },
        statusText: {
            fontSize: 12,
            fontWeight: '500' as const,
            color: actualIsSuccess ? theme.secondaryForeground : theme.destructiveForeground,
        },
        statusItem: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
        },
        statusLeft: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
        },
        statusDot: {
            width: 8,
            height: 8,
            borderRadius: 4,
        },
        statusLabel: {
            color: theme.foreground,
            fontWeight: '500' as const,
        },
        statusValue: {
            color: theme.mutedForeground,
            fontFamily: 'monospace',
        },
        successIcon: {
            color: theme.secondary,
        },
        successText: {
            color: theme.secondary,
        },
        errorText: {
            color: theme.destructive,
        },
    });

    const renderLoadingState = () => (
        <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.secondary} />
            <Body style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                Loading provider...
            </Body>
            <Caption style={{ color: theme.mutedForeground, textAlign: 'center' }}>
                Connecting to data source
            </Caption>
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

        return (
            <ScrollView style={{ flex: 1 }}>
                {/* Provider Section */}
                <View style={styles.section}>
                    <View style={styles.sectionTitle}>
                        <Database size={16} color={theme.foreground} />
                        <Body style={styles.sectionTitleText}>Data Provider</Body>
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
                                    <Caption style={styles.providerDescription}>
                                        {endpointCount > 0 ? `${endpointCount} endpoints loaded and ready` : 'Endpoints loaded and ready'}
                                    </Caption>
                                </View>

                                <View style={styles.statusBadge}>
                                    {actualIsSuccess ? (
                                        <CheckCircle size={12} color={theme.secondaryForeground} />
                                    ) : (
                                        <AlertTriangle size={12} color={theme.destructiveForeground} />
                                    )}
                                    <Caption style={styles.statusText}>
                                        {actualIsSuccess ? 'Connected' : 'Failed'}
                                    </Caption>
                                </View>
                            </View>
                        </CardContent>
                    </Card>
                </View>

                {/* Status Section */}
                <View style={styles.section}>
                    <View style={styles.sectionTitle}>
                        <CheckCircle size={16} color={theme.foreground} />
                        <Body style={styles.sectionTitleText}>Status Overview</Body>
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
                            <View style={styles.statusItem}>
                                <View style={styles.statusLeft}>
                                    <View style={[styles.statusDot, { backgroundColor: theme.secondary }]} />
                                    <Body style={styles.statusLabel}>Connection Status</Body>
                                </View>
                                <View style={styles.statusBadge}>
                                    {actualIsSuccess ? (
                                        <CheckCircle size={12} color={theme.secondaryForeground} />
                                    ) : (
                                        <AlertTriangle size={12} color={theme.destructiveForeground} />
                                    )}
                                    <Caption style={styles.statusText}>
                                        {actualIsSuccess ? 'Active' : 'Inactive'}
                                    </Caption>
                                </View>
                            </View>

                            <View style={styles.statusItem}>
                                <View style={styles.statusLeft}>
                                    <View style={[styles.statusDot, { backgroundColor: '#3b82f6' }]} />
                                    <Body style={styles.statusLabel}>Endpoints Available</Body>
                                </View>
                                <Caption style={styles.statusValue}>
                                    {endpointCount > 0 ? `${endpointCount} endpoints` : 'Ready'}
                                </Caption>
                            </View>

                            <View style={styles.statusItem}>
                                <View style={styles.statusLeft}>
                                    <View style={[styles.statusDot, { backgroundColor: '#8b5cf6' }]} />
                                    <Body style={styles.statusLabel}>Data Provider</Body>
                                </View>
                                <Caption style={styles.statusValue}>
                                    {serviceName || 'linkedin'}
                                </Caption>
                            </View>
                        </CardContent>
                    </Card>
                </View>

                {/* Success Message */}
                {actualIsSuccess && (
                    <View style={styles.section}>
                        <Card
                            style={{
                                backgroundColor: mutedBg,
                                borderColor: theme.secondary,
                            }}
                            bordered
                            elevated={false}
                        >
                            <CardContent style={{ padding: 0 }}>
                                <View style={styles.sectionTitle}>
                                    <CheckCircle size={16} color={theme.secondary} />
                                    <Body style={[styles.sectionTitleText, { color: theme.secondary }]}>
                                        Provider Ready
                                    </Body>
                                </View>
                                <Caption style={[styles.successText, { marginTop: 0 }]}>
                                    Data provider endpoints have been loaded successfully and are ready to process requests.
                                </Caption>
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