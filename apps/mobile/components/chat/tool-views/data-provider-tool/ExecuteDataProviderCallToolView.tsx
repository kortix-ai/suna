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
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
            <View className="px-6 gap-6">
                {/* Provider Info Card */}
                <View className={`rounded-xl p-4 border border-border ${providerConfig.bgColor}`}>
                    <View className="flex-row items-center gap-3 mb-2">
                        <View className={`rounded-lg p-2 ${providerConfig.bgColor}`}>
                            <Icon as={ProviderIcon} size={24} className={providerConfig.color} />
                        </View>
                        <View className="flex-1">
                            <Text className="text-lg font-roobert-semibold text-foreground">
                                {providerConfig.name}
                            </Text>
                            {serviceName && (
                                <Text className="text-sm font-roobert text-muted-foreground">
                                    Service: {serviceName}
                                </Text>
                            )}
                        </View>
                        {success ? (
                            <View className="bg-green-500/10 rounded-full p-1.5">
                                <Icon as={CheckCircle2} size={16} className="text-green-600" />
                            </View>
                        ) : (
                            <View className="bg-red-500/10 rounded-full p-1.5">
                                <Icon as={AlertCircle} size={16} className="text-red-600" />
                            </View>
                        )}
                    </View>

                    {route && (
                        <View className="bg-muted/30 rounded-lg px-3 py-2 mt-2">
                            <Text className="text-xs font-roobert-mono text-foreground" selectable>
                                {route}
                            </Text>
                        </View>
                    )}
                </View>

                {/* Error Message */}
                {output && !success && (
                    <View className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                        <View className="flex-row items-center gap-2 mb-2">
                            <Icon as={AlertCircle} size={16} className="text-red-600" />
                            <Text className="text-sm font-roobert-semibold text-red-600">
                                Execution Failed
                            </Text>
                        </View>
                        <Text className="text-xs font-roobert-mono text-red-600/80">
                            {output}
                        </Text>
                    </View>
                )}

                {/* Call Parameters */}
                {hasPayload && (
                    <View className="gap-3">
                        <View className="flex-row items-center gap-2">
                            <Icon as={Settings} size={16} className="text-foreground/70" />
                            <Text className="text-sm font-roobert-medium text-foreground/70">
                                Call Parameters
                            </Text>
                            <Icon as={ChevronRight} size={14} className="text-muted-foreground" />
                        </View>

                        <View className="gap-2">
                            {Object.entries(payload).map(([key, value]) => (
                                <View
                                    key={key}
                                    className="bg-card border border-border rounded-xl p-3 flex-row items-center justify-between"
                                >
                                    <View className="flex-row items-center gap-2 flex-1">
                                        <View className="w-2 h-2 rounded-full bg-muted-foreground/30" />
                                        <Text className="text-sm font-roobert-mono font-medium text-foreground">
                                            {key}
                                        </Text>
                                    </View>
                                    <Text className="text-sm font-roobert-mono text-muted-foreground max-w-[150px]" numberOfLines={1}>
                                        {typeof value === 'string' ? `"${value}"` : String(value)}
                                    </Text>
                                </View>
                            ))}
                        </View>

                        {/* Raw JSON Toggle */}
                        <Pressable
                            onPress={() => setShowRawJson(!showRawJson)}
                            className="flex-row items-center gap-2 py-2"
                        >
                            <Icon as={Code} size={16} className="text-foreground/70" />
                            <Text className="text-sm font-roobert-medium text-foreground/70">
                                Raw JSON
                            </Text>
                            <Icon
                                as={showRawJson ? ChevronDown : ChevronRight}
                                size={14}
                                className="text-muted-foreground"
                            />
                        </Pressable>

                        {showRawJson && (
                            <View className="bg-zinc-900 dark:bg-zinc-950 border border-border rounded-xl p-4">
                                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                                    <Text className="text-xs font-roobert-mono text-green-400" selectable>
                                        {JSON.stringify(payload, null, 2)}
                                    </Text>
                                </ScrollView>
                            </View>
                        )}
                    </View>
                )}

                {/* Empty State */}
                {!serviceName && !route && !hasPayload && (
                    <View className="py-8 items-center">
                        <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
                            <Icon as={Network} size={32} className="text-muted-foreground" />
                        </View>
                        <Text className="text-base font-roobert-medium text-foreground mb-1">
                            No Call Data
                        </Text>
                        <Text className="text-sm font-roobert text-muted-foreground text-center">
                            Will be populated when the call is executed
                        </Text>
                    </View>
                )}
            </View>
        </ScrollView>
    );
}
