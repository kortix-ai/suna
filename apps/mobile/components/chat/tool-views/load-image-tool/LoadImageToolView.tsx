import React, { useState } from 'react';
import { View, ScrollView, ActivityIndicator, Image as RNImage } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ImageIcon, AlertCircle, CheckCircle2 } from 'lucide-react-native';
import type { ToolViewProps } from '../types';

export function LoadImageToolView({
    toolCall,
    toolResult,
    isStreaming,
}: ToolViewProps) {
    const [imageLoading, setImageLoading] = useState(true);
    const [imageError, setImageError] = useState(false);

    const output = typeof toolResult?.output === 'object' ? toolResult.output : {};
    const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : {};

    const imageUrl = output?.image_url;
    const filePath = output?.file_path || args?.file_path;
    const message = output?.message;
    const isSuccess = toolResult?.success ?? true;

    const renderImage = () => {
        if (!imageUrl) return null;

        return (
            <View className="gap-3">
                <View className="bg-card border border-border rounded-2xl overflow-hidden" style={{ aspectRatio: 1 }}>
                    {imageLoading && (
                        <View className="absolute inset-0 items-center justify-center bg-muted/30">
                            <ActivityIndicator size="large" color="#0066FF" />
                        </View>
                    )}
                    {imageError ? (
                        <View className="flex-1 items-center justify-center">
                            <Icon as={AlertCircle} size={32} className="text-muted-foreground mb-2" />
                            <Text className="text-sm font-roobert text-muted-foreground">
                                Failed to load image
                            </Text>
                        </View>
                    ) : (
                        <RNImage
                            source={{ uri: imageUrl }}
                            style={{ width: '100%', height: '100%' }}
                            resizeMode="contain"
                            onLoad={() => {
                                setImageLoading(false);
                                setImageError(false);
                            }}
                            onError={() => {
                                setImageLoading(false);
                                setImageError(true);
                            }}
                        />
                    )}
                </View>


                {message && (
                    <View className="bg-card border border-border rounded-2xl p-4">
                        <Text className="text-sm font-roobert text-foreground/80">
                            {message}
                        </Text>
                    </View>
                )}
            </View>
        );
    };

    if (isStreaming) {
        return (
            <View className="flex-1 items-center justify-center py-12 px-6">
                <View className="bg-primary/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
                    <ActivityIndicator size="large" color="#0066FF" />
                </View>
                <Text className="text-xl font-roobert-semibold text-foreground mb-2">
                    Loading image...
                </Text>
                {filePath && (
                    <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3 w-full">
                        <Text className="text-sm font-roobert text-foreground/60 text-center" numberOfLines={2}>
                            {filePath}
                        </Text>
                    </View>
                )}
            </View>
        );
    }

    if (!imageUrl) {
        return (
            <View className="flex-1 items-center justify-center py-12 px-6">
                <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
                    <Icon as={isSuccess ? CheckCircle2 : AlertCircle} size={40} className="text-muted-foreground" />
                </View>
                <Text className="text-xl font-roobert-semibold text-foreground mb-2">
                    {isSuccess ? 'Image loaded' : 'Failed to load image'}
                </Text>
                {message && (
                    <Text className="text-sm font-roobert text-muted-foreground text-center mb-4">
                        {message}
                    </Text>
                )}
                {filePath && (
                    <View className="bg-card border border-border rounded-2xl px-4 py-3 w-full">
                        <View className="flex-row items-center gap-2">
                            <Icon as={ImageIcon} size={14} className="text-muted-foreground" />
                            <Text className="text-sm font-roobert text-foreground/60 flex-1" numberOfLines={1}>
                                {filePath}
                            </Text>
                        </View>
                    </View>
                )}
            </View>
        );
    }

    return (
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
            <View className="px-6 gap-6">
                {renderImage()}
            </View>
        </ScrollView>
    );
}
