import React, { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
    Network,
    CheckCircle2,
    AlertCircle,
    Briefcase,
    Home,
    ShoppingBag,
    TrendingUp,
    Users,
    MessageCircle,
    Settings,
    ChevronRight,
    ChevronDown,
    Code
} from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDataProviderCallData } from './_utils';

const PROVIDER_CONFIG = {
    linkedin: {
        name: 'LinkedIn',
        icon: Users,
        color: 'text-blue-600',
        bgColor: 'bg-blue-50'
    },
    twitter: {
        name: 'Twitter',
        icon: MessageCircle,
        color: 'text-sky-600',
        bgColor: 'bg-sky-50'
    },
    zillow: {
        name: 'Zillow',
        icon: Home,
        color: 'text-emerald-600',
        bgColor: 'bg-emerald-50'
    },
    amazon: {
        name: 'Amazon',
        icon: ShoppingBag,
        color: 'text-orange-600',
        bgColor: 'bg-orange-50'
    },
    yahoo_finance: {
        name: 'Yahoo Finance',
        icon: TrendingUp,
        color: 'text-purple-600',
        bgColor: 'bg-purple-50'
    },
    active_jobs: {
        name: 'Active Jobs',
        icon: Briefcase,
        color: 'text-indigo-600',
        bgColor: 'bg-indigo-50'
    }
};

export function ExecuteDataProviderCallToolView({ toolCall, toolResult, isStreaming = false }: ToolViewProps) {
    const [showRawJson, setShowRawJson] = useState(false);

    const { serviceName, route, payload, output, success } = extractDataProviderCallData({ toolCall, toolResult });

    const providerConfig = serviceName && PROVIDER_CONFIG[serviceName.toLowerCase() as keyof typeof PROVIDER_CONFIG]
        ? PROVIDER_CONFIG[serviceName.toLowerCase() as keyof typeof PROVIDER_CONFIG]
        : { name: serviceName || 'LinkedIn', icon: Network, color: 'text-purple-600', bgColor: 'bg-purple-50' };

    const ProviderIcon = providerConfig.icon;

    if (isStreaming) {
        return (
            <View className="flex-1 items-center justify-center py-12 px-6">
                <View className="bg-purple-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
                    <Icon as={Network} size={40} className="text-purple-500 animate-pulse" />
                </View>
                <Text className="text-xl font-roobert-semibold text-foreground mb-2">
                    Executing Call
                </Text>
                <Text className="text-sm font-roobert text-muted-foreground">
                    Calling {serviceName || 'data provider'}...
                </Text>
            </View>
        );
    }

    const hasPayload = payload && Object.keys(payload).length > 0;

    return (
        <View className="px-6 gap-6">
            {/* Provider */}
            <View className="gap-2">
                <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
                    Provider
                </Text>
                <View className="bg-card border border-border rounded-2xl p-4">
                    <Text className="text-base font-roobert-semibold text-foreground">
                        {providerConfig.name}
                    </Text>
                </View>
            </View>

            {/* Route */}
            {route && (
                <View className="gap-2">
                    <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
                        Route
                    </Text>
                    <View className="bg-card border border-border rounded-2xl p-4">
                        <Text className="text-sm font-roobert-mono text-foreground" selectable>
                            {route}
                        </Text>
                    </View>
                </View>
            )}

            {/* Error Message */}
            {output && !success && (
                <View className="gap-2">
                    <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
                        Error
                    </Text>
                    <View className="bg-card border border-border rounded-2xl p-4">
                        <Text className="text-sm font-roobert text-destructive" selectable>
                            {output}
                        </Text>
                    </View>
                </View>
            )}

            {/* Call Parameters */}
            {hasPayload && (
                <View className="gap-2">
                    <View className="flex-row items-center justify-between">
                        <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
                            Parameters
                        </Text>
                        <Pressable
                            onPress={() => setShowRawJson(!showRawJson)}
                            className="flex-row items-center gap-1.5 bg-background active:bg-card px-3 py-1.5 rounded-full border border-border"
                        >
                            <Icon
                                as={showRawJson ? ChevronDown : ChevronRight}
                                size={14}
                                className="text-foreground/60"
                            />
                            <Text className="text-xs font-roobert-medium text-foreground/60">
                                {showRawJson ? 'Hide JSON' : 'Show JSON'}
                            </Text>
                        </Pressable>
                    </View>

                    {showRawJson ? (
                        <View className="bg-card border border-border rounded-2xl" style={{ maxHeight: 400 }}>
                            <ScrollView showsVerticalScrollIndicator={false} className="p-4">
                                <Text className="text-sm font-roobert-mono text-foreground/80" selectable>
                                    {JSON.stringify(payload, null, 2)}
                                </Text>
                            </ScrollView>
                        </View>
                    ) : (
                        <View className="gap-2">
                            {Object.entries(payload).map(([key, value]) => (
                                <View
                                    key={key}
                                    className="bg-card border border-border rounded-2xl p-4"
                                >
                                    <Text className="text-xs font-roobert-medium text-foreground/50 mb-1">
                                        {key}
                                    </Text>
                                    <Text className="text-sm font-roobert text-foreground" selectable>
                                        {typeof value === 'string' ? value : JSON.stringify(value)}
                                    </Text>
                                </View>
                            ))}
                        </View>
                    )}
                </View>
            )}

            {/* Status */}
            <View className="gap-2">
                <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
                    Status
                </Text>
                <View className={`flex-row items-center gap-2 rounded-2xl p-4 border ${success
                    ? 'bg-primary/5 border-primary/20'
                    : 'bg-destructive/5 border-destructive/20'
                    }`}>
                    <Icon
                        as={success ? CheckCircle2 : AlertCircle}
                        size={18}
                        className={success ? 'text-primary' : 'text-destructive'}
                    />
                    <Text className={`text-sm font-roobert-medium ${success ? 'text-primary' : 'text-destructive'}`}>
                        {success ? 'Call Successful' : 'Call Failed'}
                    </Text>
                </View>
            </View>
        </View>
    );
}
