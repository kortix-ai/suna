import { useTheme } from '@/hooks/useThemeColor';
import { ParsedToolCall, getToolDisplayInfo } from '@/utils/message-parser';
import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Body } from './Typography';

interface ToolCallRendererProps {
    toolCalls: ParsedToolCall[];
    onToolPress?: (toolCall: ParsedToolCall) => void;
}

export const ToolCallRenderer: React.FC<ToolCallRendererProps> = ({
    toolCalls,
    onToolPress,
}) => {
    const theme = useTheme();

    if (toolCalls.length === 0) return null;

    return (
        <View style={styles.container}>
            {toolCalls.map((toolCall, index) => {
                const { displayName, primaryParam } = getToolDisplayInfo(toolCall);

                return (
                    <TouchableOpacity
                        key={`${toolCall.functionName}-${index}`}
                        style={[
                            styles.toolCall,
                            {
                                backgroundColor: theme.muted,
                                borderColor: theme.mutedForeground + '20',
                            }
                        ]}
                        onPress={() => onToolPress?.(toolCall)}
                        activeOpacity={0.7}
                    >
                        <View style={styles.toolHeader}>
                            <Body style={[styles.toolName, { color: theme.foreground }]}>
                                {displayName}
                            </Body>
                        </View>
                        {primaryParam && (
                            <Body
                                style={[styles.toolParam, { color: theme.mutedForeground }]}
                                numberOfLines={1}
                                ellipsizeMode="tail"
                            >
                                {primaryParam}
                            </Body>
                        )}
                    </TouchableOpacity>
                );
            })}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {

        marginVertical: 4,
    },
    toolCall: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginVertical: 2,
        borderRadius: 16,
        borderWidth: 1,
    },
    toolHeader: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    toolName: {
        fontSize: 13,
        fontWeight: '600',
    },
    toolParam: {
        fontSize: 12,
        marginTop: 2,
        opacity: 0.8,
    },
}); 