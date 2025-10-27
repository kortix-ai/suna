import { useTheme } from '@/hooks/useThemeColor';
import { ParsedToolCall } from '@/utils/message-parser';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Body, Caption } from '../Typography';
import { AskToolView } from './AskToolView';

// Generic tool view for unknown tools
const GenericToolViewComponent: React.FC<{ toolCall: ParsedToolCall }> = ({ toolCall }) => {
    const theme = useTheme();

    const styles = StyleSheet.create({
        container: {
            padding: 16,
            backgroundColor: theme.muted + '20',
            borderRadius: 8,
            marginBottom: 12,
        },
        name: {
            color: theme.foreground,
            fontWeight: '600',
            marginBottom: 8,
        },
        param: {
            color: theme.mutedForeground,
            marginBottom: 4,
        },
        value: {
            color: theme.foreground,
            fontFamily: 'monospace',
            fontSize: 12,
        },
    });

    return (
        <View style={styles.container}>
            <Body style={styles.name}>{toolCall.functionName}</Body>
            {Object.entries(toolCall.parameters).map(([key, value]) => (
                <View key={key}>
                    <Caption style={styles.param}>{key}:</Caption>
                    <Body style={styles.value}>{String(value)}</Body>
                </View>
            ))}
        </View>
    );
};

// File operation tool view
export const FileToolView: React.FC<{ toolCall: ParsedToolCall }> = ({ toolCall }) => {
    const theme = useTheme();

    const styles = StyleSheet.create({
        container: {
            padding: 16,
            backgroundColor: theme.muted + '20',
            borderRadius: 8,
            marginBottom: 12,
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 12,
        },
        icon: {
            width: 24,
            height: 24,
            borderRadius: 4,
            backgroundColor: theme.primary + '20',
            marginRight: 8,
        },
        name: {
            color: theme.foreground,
            fontWeight: '600',
        },
        filePath: {
            color: theme.primary,
            fontFamily: 'monospace',
            fontSize: 12,
            marginBottom: 8,
        },
        content: {
            color: theme.mutedForeground,
            fontSize: 12,
            fontFamily: 'monospace',
            maxHeight: 200,
        },
    });

    const filePath = toolCall.parameters.file_path || toolCall.parameters.path;
    const content = toolCall.parameters.file_contents || toolCall.parameters.content;

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={styles.icon} />
                <Body style={styles.name}>{toolCall.functionName.replace(/-/g, ' ')}</Body>
            </View>
            {filePath && <Body style={styles.filePath}>{filePath}</Body>}
            {content && <Body style={styles.content}>{String(content).substring(0, 500)}</Body>}
        </View>
    );
};

// Command execution tool view
export const CommandToolView: React.FC<{ toolCall: ParsedToolCall }> = ({ toolCall }) => {
    const theme = useTheme();

    const styles = StyleSheet.create({
        container: {
            padding: 16,
            backgroundColor: theme.muted + '20',
            borderRadius: 8,
            marginBottom: 12,
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 12,
        },
        icon: {
            width: 24,
            height: 24,
            borderRadius: 4,
            backgroundColor: theme.destructive + '20',
            marginRight: 8,
        },
        name: {
            color: theme.foreground,
            fontWeight: '600',
        },
        command: {
            color: theme.foreground,
            fontFamily: 'monospace',
            fontSize: 12,
            backgroundColor: theme.muted + '40',
            padding: 8,
            borderRadius: 4,
        },
    });

    const command = toolCall.parameters.command;

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={styles.icon} />
                <Body style={styles.name}>Execute Command</Body>
            </View>
            {command && <Body style={styles.command}>{String(command)}</Body>}
        </View>
    );
};

// Web search tool view
export const WebSearchToolView: React.FC<{ toolCall: ParsedToolCall }> = ({ toolCall }) => {
    const theme = useTheme();

    const styles = StyleSheet.create({
        container: {
            padding: 16,
            backgroundColor: theme.muted + '20',
            borderRadius: 8,
            marginBottom: 12,
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 12,
        },
        icon: {
            width: 24,
            height: 24,
            borderRadius: 4,
            backgroundColor: theme.accent + '20',
            marginRight: 8,
        },
        name: {
            color: theme.foreground,
            fontWeight: '600',
        },
        query: {
            color: theme.foreground,
            fontStyle: 'italic',
            marginBottom: 8,
        },
    });

    const query = toolCall.parameters.query || toolCall.parameters.search_query;

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={styles.icon} />
                <Body style={styles.name}>Web Search</Body>
            </View>
            {query && <Body style={styles.query}>&quot;{String(query)}&quot;</Body>}
        </View>
    );
};

// Ask tool view wrapper
const AskToolViewWrapper: React.FC<{ toolCall: ParsedToolCall }> = ({ toolCall }) => {
    return (
        <AskToolView
            toolCall={toolCall}
            isStreaming={false}
            isSuccess={true}
        />
    );
};

// Main tool view component
export const ToolView: React.FC<{ toolCall: ParsedToolCall }> = ({ toolCall }) => {
    const functionName = toolCall.functionName?.toLowerCase();

    if (functionName === 'ask') {
        return <AskToolViewWrapper toolCall={toolCall} />;
    }

    if (functionName?.includes('str-replace') || functionName?.includes('replace')) {
        return <FileToolView toolCall={toolCall} />;
    }

    if (functionName?.includes('file') || functionName?.includes('read') || functionName?.includes('write') || functionName?.includes('edit')) {
        return <FileToolView toolCall={toolCall} />;
    }

    if (functionName?.includes('command') || functionName?.includes('exec')) {
        return <CommandToolView toolCall={toolCall} />;
    }

    if (functionName?.includes('search') || functionName?.includes('web')) {
        return <WebSearchToolView toolCall={toolCall} />;
    }

    return <GenericToolViewComponent toolCall={toolCall} />;
};

// Export all components
export { AskToolView } from './AskToolView';
export { CommandToolView as CommandToolViewComponent } from './CommandToolView';
export { FileOperationToolView } from './FileOperationToolView';
export { GenericToolView } from './GenericToolView';
export { StrReplaceToolView } from './StrReplaceToolView';
export { ToolHeader } from './ToolHeader';
export { toolViewRegistry } from './ToolViewRegistry';

