import { useTheme } from '@/hooks/useThemeColor';
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

interface TerminalViewProps {
    output: string;
    exitCode?: number | null;
    showError?: boolean;
    maxPreviewLines?: number;
    title?: string;
}

export function TerminalView({
    output,
    exitCode = null,
    showError = true,
    maxPreviewLines = 10,
    title = 'Terminal output'
}: TerminalViewProps) {
    const theme = useTheme();
    const [showFullOutput, setShowFullOutput] = useState(true);

    // Convert color-mix(in oklab, var(--muted) 20%, transparent) to hex
    const mutedBg = theme.muted === '#e8e8e8' ? '#e8e8e833' : '#30303033';

    const processedOutput = (() => {
        if (!output) return [];

        let processedOutput = output;

        // Try to parse JSON if it looks like JSON
        try {
            if (typeof output === 'string' && output.trim().startsWith('{')) {
                const parsed = JSON.parse(output);
                if (parsed && typeof parsed === 'object' && parsed.output) {
                    processedOutput = parsed.output;
                }
            }
        } catch (e) {
            // Use original output
        }

        processedOutput = String(processedOutput);

        // Process escape sequences
        processedOutput = processedOutput
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\'/g, "'")
            .replace(/\\\\/g, '\\');

        // Process unicode
        processedOutput = processedOutput.replace(/\\u([0-9a-fA-F]{4})/g, (match, group) => {
            return String.fromCharCode(parseInt(group, 16));
        });

        return processedOutput.split('\n');
    })();

    const hasMoreLines = processedOutput.length > maxPreviewLines;
    const previewLines = processedOutput.slice(0, maxPreviewLines);
    const linesToShow = showFullOutput ? processedOutput : previewLines;

    const styles = StyleSheet.create({
        container: {
            backgroundColor: mutedBg,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.muted,
            overflow: 'hidden',
        },
        header: {
            backgroundColor: theme.muted,
            paddingHorizontal: 16,
            paddingVertical: 12,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottomWidth: 1,
            borderBottomColor: theme.border,
        },
        headerLeft: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
        },
        headerText: {
            fontWeight: '600',
            color: theme.foreground,
            fontSize: 14,
        },
        errorBadge: {
            backgroundColor: theme.destructive + '20',
            borderColor: theme.destructive,
            borderWidth: 1,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
        },
        errorBadgeText: {
            color: theme.destructive,
            fontSize: 12,
            fontWeight: '500',
        },
        outputBody: {
            padding: 16,
            maxHeight: 300,
        },
        outputLine: {
            fontFamily: 'monospace',
            fontSize: 13,
            color: theme.foreground,
            lineHeight: 18,
            marginBottom: 2,
        },
        moreLines: {
            color: theme.mutedForeground,
            borderTopWidth: 1,
            borderTopColor: theme.border,
            paddingTop: 12,
            marginTop: 12,
            fontStyle: 'italic',
            fontSize: 12,
        },
        noOutputContainer: {
            padding: 24,
            alignItems: 'center',
            justifyContent: 'center',
        },
        noOutputText: {
            color: theme.mutedForeground,
            textAlign: 'center',
            fontSize: 14,
            marginTop: 8,
        },
    });

    if (!output) {
        return (
            <View style={styles.container}>
                <View style={styles.header}>
                    <View style={styles.headerLeft}>
                        <Ionicons name="terminal" size={16} color={theme.foreground} />
                        <Text style={styles.headerText}>{title}</Text>
                    </View>
                </View>
                <View style={styles.noOutputContainer}>
                    <Ionicons name="time-outline" size={32} color={theme.mutedForeground} />
                    <Text style={styles.noOutputText}>No output received</Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <Ionicons name="terminal" size={16} color={theme.foreground} />
                    <Text style={styles.headerText}>{title}</Text>
                </View>
                {showError && exitCode !== null && exitCode !== 0 && (
                    <View style={styles.errorBadge}>
                        <Ionicons name="warning" size={12} color={theme.destructive} />
                        <Text style={styles.errorBadgeText}>Error</Text>
                    </View>
                )}
            </View>
            <ScrollView style={styles.outputBody} showsVerticalScrollIndicator={false}>
                {linesToShow.map((line, index) => (
                    <Text key={index} style={styles.outputLine}>
                        {line || ' '}
                    </Text>
                ))}
                {!showFullOutput && hasMoreLines && (
                    <Text style={styles.moreLines}>
                        + {processedOutput.length - maxPreviewLines} more lines
                    </Text>
                )}
            </ScrollView>
        </View>
    );
} 