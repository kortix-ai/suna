import { useTheme } from '@/hooks/useThemeColor';
import { AlertTriangle, CheckCircle, CheckCircle2, Clock, Computer, MessageCircleQuestion } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Caption, H5 } from '../Typography';
import { useToolViewContext } from './ToolViewContext';

interface ToolHeaderProps {
    toolName: string;
    isStreaming?: boolean;
    isSuccess?: boolean;
    icon?: React.ComponentType<any>;
}

const getToolIcon = (toolName: string) => {
    switch (toolName) {
        case 'ask':
            return MessageCircleQuestion;
        case 'complete':
            return CheckCircle2;
        default:
            return Computer;
    }
};

const getToolDisplayName = (toolName: string) => {
    switch (toolName) {
        case 'ask':
            return 'Ask User';
        case 'complete':
            return 'Task Complete';
        default:
            return toolName?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Unknown Tool';
    }
};

export const ToolHeader: React.FC<ToolHeaderProps> = ({
    toolName,
    isStreaming = false,
    isSuccess = true,
    icon: IconComponent
}) => {
    const theme = useTheme();

    // Try to get context, but don't throw if not available (for tools without extensions)
    let context;
    try {
        context = useToolViewContext();
    } catch {
        context = null;
    }

    const Icon = IconComponent || getToolIcon(toolName);
    const displayName = getToolDisplayName(toolName);

    const styles = StyleSheet.create({
        header: {
            backgroundColor: theme.muted + '20',
            paddingHorizontal: 24,
            paddingVertical: 16,
            borderBottomWidth: 1,
            borderBottomColor: theme.border,
            height: 64,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
        },
        headerLeft: {
            flexDirection: 'row',
            alignItems: 'center',
        },
        title: {
            color: theme.foreground,
        },
        statusBadge: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 12,
        },
        statusText: {
            fontSize: 12,
            fontWeight: '600' as const,
            marginLeft: 4,
        },
    });

    const statusColor = isStreaming
        ? theme.accent
        : isSuccess
            ? theme.primary
            : theme.destructive;

    const statusText = isStreaming
        ? 'Running...'
        : isSuccess
            ? 'Success'
            : 'Failed';

    const StatusIcon = isStreaming
        ? Clock
        : isSuccess
            ? CheckCircle
            : AlertTriangle;

    return (
        <View style={styles.header}>
            <View style={styles.headerLeft}>
                <H5 style={styles.title}>{displayName}</H5>
            </View>

            {context?.headerExtensions ? (
                context.headerExtensions
            ) : (
                <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
                    <StatusIcon size={12} color={statusColor} />
                    <Caption style={[styles.statusText, { color: statusColor }]}>
                        {statusText}
                    </Caption>
                </View>
            )}
        </View>
    );
};
