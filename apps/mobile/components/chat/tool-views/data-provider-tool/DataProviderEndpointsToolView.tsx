import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
    Database,
    CheckCircle2,
    AlertCircle,
    Briefcase,
    Home,
    ShoppingBag,
    TrendingUp,
    Users,
    MessageCircle,
    Globe
} from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDataProviderEndpointsData } from './_utils';

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

export function DataProviderEndpointsToolView({ toolCall, toolResult, isStreaming = false }: ToolViewProps) {
    const { serviceName, endpoints, success } = extractDataProviderEndpointsData({ toolCall, toolResult });

    const providerConfig = serviceName && PROVIDER_CONFIG[serviceName as keyof typeof PROVIDER_CONFIG]
        ? PROVIDER_CONFIG[serviceName as keyof typeof PROVIDER_CONFIG]
        : { name: serviceName || 'LinkedIn', icon: Database, color: 'text-blue-600', bgColor: 'bg-blue-50' };

    const ProviderIcon = providerConfig.icon;
    const endpointCount = endpoints && typeof endpoints === 'object' ? Object.keys(endpoints).length : 0;

    if (isStreaming) {
        return (
            <View className="flex-1 items-center justify-center py-12 px-6">
                <View className="bg-blue-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
                    <Icon as={Globe} size={40} className="text-blue-500 animate-pulse" />
                </View>
                <Text className="text-xl font-roobert-semibold text-foreground mb-2">
                    Loading Provider
                </Text>
                <Text className="text-sm font-roobert text-muted-foreground">
                    Connecting to data source...
                </Text>
            </View>
        );
    }

    return (
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
            <View className="px-6 gap-6">
                {/* Provider Info Card */}
                <View className={`rounded-xl p-4 border border-border ${providerConfig.bgColor}`}>
                    <View className="flex-row items-center gap-3 mb-3">
                        <View className={`rounded-lg p-2 ${providerConfig.bgColor}`}>
                            <Icon as={ProviderIcon} size={24} className={providerConfig.color} />
                        </View>
                        <View className="flex-1">
                            <Text className="text-lg font-roobert-semibold text-foreground">
                                {providerConfig.name}
                            </Text>
                            <Text className="text-sm font-roobert text-muted-foreground">
                                Data Provider
                            </Text>
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

                    {endpointCount > 0 && (
                        <Text className="text-sm font-roobert text-foreground/60">
                            {endpointCount} endpoint{endpointCount !== 1 ? 's' : ''} loaded and ready
                        </Text>
                    )}
                </View>

                {/* Status Cards */}
                <View className="gap-3">
                    <Text className="text-sm font-roobert-medium text-foreground/70">
                        Provider Status
                    </Text>

                    {/* Connection Status */}
                    <View className="bg-card border border-border rounded-xl p-3 flex-row items-center justify-between">
                        <View className="flex-row items-center gap-3">
                            <View className={`w-2 h-2 rounded-full ${success ? 'bg-green-500' : 'bg-red-500'}`} />
                            <Text className="text-sm font-roobert text-foreground">
                                Connection Status
                            </Text>
                        </View>
                        <View className={`px-2 py-1 rounded ${success ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
                            <Text className={`text-xs font-roobert-medium ${success ? 'text-green-600' : 'text-red-600'}`}>
                                {success ? 'Active' : 'Inactive'}
                            </Text>
                        </View>
                    </View>

                    {/* Endpoints Available */}
                    <View className="bg-card border border-border rounded-xl p-3 flex-row items-center justify-between">
                        <View className="flex-row items-center gap-3">
                            <View className="w-2 h-2 rounded-full bg-blue-500" />
                            <Text className="text-sm font-roobert text-foreground">
                                Endpoints Available
                            </Text>
                        </View>
                        <View className="px-2 py-1 rounded bg-muted">
                            <Text className="text-xs font-roobert-medium text-foreground">
                                {endpointCount > 0 ? `${endpointCount} endpoints` : 'Ready'}
                            </Text>
                        </View>
                    </View>

                    {/* Service Name */}
                    <View className="bg-card border border-border rounded-xl p-3 flex-row items-center justify-between">
                        <View className="flex-row items-center gap-3">
                            <View className="w-2 h-2 rounded-full bg-purple-500" />
                            <Text className="text-sm font-roobert text-foreground">
                                Data Provider
                            </Text>
                        </View>
                        <Text className="text-sm font-roobert-mono text-muted-foreground">
                            {serviceName || 'linkedin'}
                        </Text>
                    </View>
                </View>

                {/* Success Message */}
                {success && (
                    <View className="bg-green-500/10 border border-green-500/20 rounded-xl p-4">
                        <View className="flex-row items-center gap-2 mb-2">
                            <Icon as={CheckCircle2} size={16} className="text-green-600" />
                            <Text className="text-sm font-roobert-semibold text-green-600">
                                Provider Ready
                            </Text>
                        </View>
                        <Text className="text-xs font-roobert text-green-600/80">
                            Data provider endpoints have been loaded successfully and are ready to process requests.
                        </Text>
                    </View>
                )}
            </View>
        </ScrollView>
    );
}
