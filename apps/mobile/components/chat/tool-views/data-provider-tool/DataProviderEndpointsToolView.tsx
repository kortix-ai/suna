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
        <View className="px-6 gap-6">
            {/* Provider Name */}
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

            {/* Endpoints Count */}
            {endpointCount > 0 && (
                <View className="gap-2">
                    <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
                        Endpoints
                    </Text>
                    <View className="bg-card border border-border rounded-2xl p-4">
                        <Text className="text-sm font-roobert text-foreground">
                            {endpointCount} endpoint{endpointCount !== 1 ? 's' : ''} loaded
                        </Text>
                    </View>
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
                        {success ? 'Provider Ready' : 'Provider Failed'}
                    </Text>
                </View>
            </View>
        </View>
    );
}
