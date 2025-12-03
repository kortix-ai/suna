import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
    FileText,
    Presentation,
    CheckCircle2,
    AlertCircle,
    Loader2,
    Download,
    Info,
    Layers
} from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractExportData } from './_utils';

export function ExportToolView({
    toolCall,
    toolResult,
    isStreaming = false
}: ToolViewProps) {
    const {
        presentationName,
        filePath,
        downloadUrl,
        totalSlides,
        storedLocally,
        message,
        note,
        success,
        format,
    } = extractExportData({ toolCall, toolResult });

    const FormatIcon = format === 'pdf' ? FileText : Presentation;
    const formatLabel = format.toUpperCase();

    if (isStreaming) {
        return (
            <View className="flex-1 items-center justify-center py-12 px-6">
                <View className="bg-blue-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
                    <Icon as={FormatIcon} size={40} className="text-blue-500 animate-pulse" />
                </View>
                <Text className="text-xl font-roobert-semibold text-foreground mb-2">
                    Exporting to {formatLabel}
                </Text>
                {presentationName && (
                    <Text className="text-sm font-roobert text-muted-foreground text-center">
                        {presentationName}
                    </Text>
                )}
            </View>
        );
    }

    return (
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
            <View className="px-6 gap-6">
                {/* Success/Error Status */}
                <View className="pt-3 items-center">
                    <View className={`${success ? 'bg-blue-500/10' : 'bg-red-500/10'} rounded-2xl items-center justify-center mb-4`} style={{ width: 64, height: 64 }}>
                        <Icon
                            as={success ? CheckCircle2 : AlertCircle}
                            size={32}
                            className={success ? 'text-blue-600' : 'text-red-600'}
                        />
                    </View>
                    <Text className="text-base font-roobert-medium text-foreground mb-1">
                        {success ? `Exported to ${formatLabel}` : 'Export Failed'}
                    </Text>
                    {presentationName && (
                        <Text className="text-sm font-roobert text-muted-foreground">
                            {presentationName}
                        </Text>
                    )}
                </View>

                {/* Export Details */}
                {success && (presentationName || totalSlides !== undefined) && (
                    <View className="bg-card border border-border rounded-xl p-4 gap-3">
                        <View className="flex-row items-center gap-2 mb-2">
                            <Icon as={FormatIcon} size={16} className="text-muted-foreground" />
                            <Text className="text-sm font-roobert-medium text-foreground">
                                Export Details
                            </Text>
                        </View>

                        {presentationName && (
                            <View className="gap-1">
                                <Text className="text-xs font-roobert-medium text-muted-foreground">
                                    Presentation
                                </Text>
                                <Text className="text-sm font-roobert text-foreground">
                                    {presentationName}
                                </Text>
                            </View>
                        )}

                        {totalSlides !== undefined && (
                            <View className="gap-1">
                                <Text className="text-xs font-roobert-medium text-muted-foreground">
                                    Slides
                                </Text>
                                <View className="flex-row items-center gap-1.5">
                                    <Icon as={Layers} size={14} className="text-foreground/60" />
                                    <Text className="text-sm font-roobert text-foreground">
                                        {totalSlides} slide{totalSlides !== 1 ? 's' : ''}
                                    </Text>
                                </View>
                            </View>
                        )}

                        {storedLocally !== undefined && (
                            <View className="gap-1">
                                <Text className="text-xs font-roobert-medium text-muted-foreground">
                                    Storage
                                </Text>
                                <Text className="text-sm font-roobert text-foreground">
                                    {storedLocally ? 'Stored locally' : 'Temporary'}
                                </Text>
                            </View>
                        )}

                        {downloadUrl && (
                            <View className="gap-1">
                                <Text className="text-xs font-roobert-medium text-muted-foreground">
                                    Download Path
                                </Text>
                                <Text className="text-xs font-roobert-mono text-foreground/60" selectable>
                                    {downloadUrl}
                                </Text>
                            </View>
                        )}
                    </View>
                )}

                {/* Download Note for Mobile */}
                {success && storedLocally && (
                    <View className="bg-card border border-border rounded-2xl p-4">
                        <View className="flex-row items-start gap-3">
                            <View className="bg-primary/10 rounded-full p-2">
                                <Icon as={Download} size={16} className="text-primary" />
                            </View>
                            <Text className="text-sm font-roobert text-foreground/80 flex-1">
                                The {formatLabel} file is stored in the workspace and can be accessed via the web interface for download.
                            </Text>
                        </View>
                    </View>
                )}

            </View>
        </ScrollView>
    );
}
