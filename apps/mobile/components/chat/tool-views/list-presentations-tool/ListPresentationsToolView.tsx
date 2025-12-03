import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Presentation, CheckCircle2, AlertCircle, Folder, Globe } from 'lucide-react-native';
import type { ToolViewProps } from '../types';

export function ListPresentationsToolView({
    toolCall,
    toolResult,
    isStreaming,
}: ToolViewProps) {
    const output = typeof toolResult?.output === 'object' ? toolResult.output : {};
    const presentations = output?.presentations || [];
    const message = output?.message;
    const note = output?.note;
    const presentationsDirectory = output?.presentations_directory;
    const isSuccess = toolResult?.success ?? true;

    if (isStreaming) {
        return (
            <View className="flex-1 items-center justify-center py-12 px-6">
                <View className="bg-background border-border border rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
                    <Icon as={Presentation} size={40} className="text-muted-foreground" />
                </View>
                <Text className="text-xl font-roobert-semibold text-foreground mb-2">
                    Loading Presentations...
                </Text>
            </View>
        );
    }

    if (presentations.length === 0) {
        return (
            <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
                <View className="px-6 py-12 items-center">
                    <View className="bg-background border-border border rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
                        <Icon as={Presentation} size={40} className="text-muted-foreground" />
                    </View>
                    <Text className="text-xl font-roobert-semibold text-foreground mb-2">
                        No Presentations Yet
                    </Text>
                    {message && (
                        <Text className="text-sm font-roobert text-muted-foreground text-center mb-4">
                            {message}
                        </Text>
                    )}

                    {presentationsDirectory && (
                        <View className="bg-card border border-border rounded-2xl px-4 py-3 self-center">
                            <View className="flex-row items-center gap-2">
                                <Icon as={Folder} size={14} className="text-muted-foreground" />
                                <Text className="text-sm font-roobert text-foreground/60" numberOfLines={1}>
                                    {presentationsDirectory}
                                </Text>
                            </View>
                        </View>
                    )}

                </View>
            </ScrollView>
        );
    }

    return (
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
            <View className="px-6 gap-6">
                {message && (
                    <View className="bg-card border border-border rounded-2xl p-4">
                        <Text className="text-sm font-roobert text-foreground/80">
                            {message}
                        </Text>
                    </View>
                )}

                <View className="gap-3">
                    <View className="flex-row items-center justify-between mb-2">
                        <Text className="text-sm font-roobert-medium text-foreground/70">
                            Presentations ({presentations.length})
                        </Text>
                        {presentationsDirectory && (
                            <View className="bg-card border border-border rounded-2xl px-4 py-3 self-center">
                                <View className="flex-row items-center gap-2">
                                    <Icon as={Folder} size={14} className="text-muted-foreground" />
                                    <Text className="text-sm font-roobert text-foreground/60" numberOfLines={1}>
                                        {presentationsDirectory.replace('/workspace/', '')}
                                    </Text>
                                </View>
                            </View>
                        )}
                    </View>

                    {presentations.map((presentation: any, index: number) => (
                        <View
                            key={index}
                            className="bg-card border border-border rounded-2xl p-4"
                        >
                            <View className="flex-row items-start gap-3">
                                <View className="bg-orange-500/10 rounded-xl p-2">
                                    <Icon as={Presentation} size={20} className="text-orange-600" />
                                </View>
                                <View className="flex-1">
                                    <Text className="text-base font-roobert-semibold text-foreground mb-1">
                                        {presentation.name || presentation.presentation_name || 'Untitled'}
                                    </Text>
                                    {presentation.title && (
                                        <Text className="text-sm font-roobert text-foreground/70 mb-2">
                                            {presentation.title}
                                        </Text>
                                    )}
                                    {presentation.description && (
                                        <Text className="text-xs font-roobert text-muted-foreground mb-2">
                                            {presentation.description}
                                        </Text>
                                    )}
                                    <View className="flex-row items-center gap-4 mt-2">
                                        {presentation.slide_count !== undefined && (
                                            <Text className="text-xs font-roobert text-muted-foreground">
                                                {presentation.slide_count} {presentation.slide_count === 1 ? 'slide' : 'slides'}
                                            </Text>
                                        )}
                                        {presentation.created_at && (
                                            <Text className="text-xs font-roobert text-muted-foreground">
                                                Created {new Date(presentation.created_at).toLocaleDateString()}
                                            </Text>
                                        )}
                                    </View>
                                </View>
                            </View>
                        </View>
                    ))}
                </View>

                {note && (
                    <View className="bg-blue-500/10 border border-blue-500/20 rounded-2xl p-4">
                        <Text className="text-sm font-roobert text-blue-600 dark:text-blue-400">
                            💡 {note}
                        </Text>
                    </View>
                )}
            </View>
        </ScrollView>
    );
}
