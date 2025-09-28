import { useTheme } from '@/hooks/useThemeColor';
import { AlertTriangle, Minus, Plus } from 'lucide-react-native';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { Body, Caption, H4 } from '../Typography';
import { ToolViewProps } from './ToolViewRegistry';

interface StrReplaceToolViewProps extends ToolViewProps {
    assistantContent?: string;
    toolContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
    toolCall?: any;
}

interface DiffLine {
    type: 'added' | 'removed' | 'unchanged';
    content: string;
    lineNumber: number;
}

const extractStrReplaceData = (toolCall?: any, toolContent?: string) => {
    let filePath = '';
    let oldStr = '';
    let newStr = '';
    let isSuccess = true;
    let errorMessage = '';

    // Extract from tool call parameters
    if (toolCall?.parameters) {
        filePath = toolCall.parameters.file_path ||
            toolCall.parameters.path ||
            toolCall.parameters.target_file || '';

        oldStr = toolCall.parameters.old_string ||
            toolCall.parameters.old_str ||
            toolCall.parameters.old || '';

        newStr = toolCall.parameters.new_string ||
            toolCall.parameters.new_str ||
            toolCall.parameters.new || '';
    }

    // Parse tool content if available
    if (toolContent) {
        try {
            const parsed = JSON.parse(toolContent);

            if (parsed.tool_execution) {
                const toolExecution = parsed.tool_execution;

                // Extract arguments
                if (toolExecution.arguments) {
                    filePath = toolExecution.arguments.file_path ||
                        toolExecution.arguments.path ||
                        toolExecution.arguments.target_file || filePath;

                    oldStr = toolExecution.arguments.old_string ||
                        toolExecution.arguments.old_str ||
                        toolExecution.arguments.old || oldStr;

                    newStr = toolExecution.arguments.new_string ||
                        toolExecution.arguments.new_str ||
                        toolExecution.arguments.new || newStr;
                }

                // Extract result
                if (toolExecution.result) {
                    const result = toolExecution.result;

                    if (result.success !== undefined) {
                        isSuccess = result.success;
                    }

                    if (result.error) {
                        errorMessage = result.error;
                    }
                }
            }
        } catch (e) {
            // If parsing fails, mark as error
            isSuccess = false;
            errorMessage = 'Failed to parse tool content';
        }
    }

    return {
        filePath,
        oldStr,
        newStr,
        isSuccess,
        errorMessage
    };
};

const generateDiff = (oldStr: string, newStr: string): DiffLine[] => {
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const diff: DiffLine[] = [];

    let lineNumber = 1;
    const maxLines = Math.max(oldLines.length, newLines.length);

    // Enhanced diff - show context and better line-by-line comparison
    for (let i = 0; i < maxLines; i++) {
        const oldLine = i < oldLines.length ? oldLines[i] : null;
        const newLine = i < newLines.length ? newLines[i] : null;

        if (oldLine !== null && newLine !== null) {
            if (oldLine === newLine) {
                // Lines are identical - show as unchanged
                diff.push({
                    type: 'unchanged',
                    content: oldLine,
                    lineNumber: lineNumber++
                });
            } else {
                // Lines are different - show removed then added
                diff.push({
                    type: 'removed',
                    content: oldLine,
                    lineNumber: lineNumber
                });
                diff.push({
                    type: 'added',
                    content: newLine,
                    lineNumber: lineNumber++
                });
            }
        } else if (oldLine !== null) {
            // Only old line exists - show as removed
            diff.push({
                type: 'removed',
                content: oldLine,
                lineNumber: lineNumber++
            });
        } else if (newLine !== null) {
            // Only new line exists - show as added
            diff.push({
                type: 'added',
                content: newLine,
                lineNumber: lineNumber++
            });
        }
    }

    return diff;
};

export function StrReplaceToolView({
    name = 'str-replace',
    toolCall,
    toolContent,
    isStreaming = false,
    isSuccess = true,
    ...props
}: StrReplaceToolViewProps) {
    const theme = useTheme();

    console.log('🔄 STR REPLACE TOOL RECEIVED:', !!toolContent, toolContent?.length || 0);

    if (!toolContent && !isStreaming) {
        console.log('❌ STR REPLACE TOOL: NO CONTENT');
        return (
            <View style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                padding: 20,
                backgroundColor: theme.background,
            }}>
                <Body style={{
                    color: theme.mutedForeground,
                    fontSize: 16,
                    textAlign: 'center',
                }}>
                    No string replacement data available
                </Body>
            </View>
        );
    }

    const {
        filePath,
        oldStr,
        newStr,
        isSuccess: actualIsSuccess,
        errorMessage
    } = extractStrReplaceData(toolCall, toolContent);

    const diff = oldStr && newStr ? generateDiff(oldStr, newStr) : [];
    const stats = {
        additions: diff.filter(d => d.type === 'added').length,
        deletions: diff.filter(d => d.type === 'removed').length
    };

    const styles = StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: theme.background,
        },
        fileHeader: {
            backgroundColor: theme.mutedWithOpacity(0.05),
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: theme.border,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
        },
        filePath: {
            fontSize: 13,
            fontFamily: 'monospace',
            color: theme.foreground,
        },
        stats: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 16,
        },
        stat: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
        },
        statText: {
            fontSize: 12,
            color: theme.mutedForeground,
        },
        diffContainer: {
            flex: 1,
        },
        diffLine: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            paddingHorizontal: 12,
            paddingVertical: 2,
            minHeight: 24,
        },
        lineNumber: {
            width: 40,
            fontSize: 11,
            fontFamily: 'monospace',
            color: theme.mutedForeground,
            textAlign: 'right',
            marginRight: 8,
        },
        diffIcon: {
            width: 16,
            marginRight: 8,
            alignItems: 'center',
            justifyContent: 'center',
        },
        diffContent: {
            flex: 1,
            fontSize: 12,
            fontFamily: 'monospace',
            lineHeight: 16,
        },
        loadingContainer: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            gap: 16,
        },
        errorContainer: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            gap: 16,
            paddingHorizontal: 32,
        },
        errorText: {
            textAlign: 'center',
            color: theme.mutedForeground,
        },
    });

    const renderFileHeader = () => (
        <View style={styles.fileHeader}>
            <Body style={styles.filePath}>
                {filePath || 'Unknown file'}
            </Body>
            <View style={styles.stats}>
                <View style={styles.stat}>
                    <Plus size={12} color={theme.primary} />
                    <Caption style={styles.statText}>{stats.additions}</Caption>
                </View>
                <View style={styles.stat}>
                    <Minus size={12} color={theme.destructive} />
                    <Caption style={styles.statText}>{stats.deletions}</Caption>
                </View>
            </View>
        </View>
    );

    const renderDiffLine = (line: DiffLine, index: number) => {
        const lineStyle = [
            styles.diffLine,
            line.type === 'added' && { backgroundColor: theme.primaryWithOpacity(0.1) },
            line.type === 'removed' && { backgroundColor: theme.destructive + '20' },
        ];

        const contentColor = line.type === 'added'
            ? theme.primary
            : line.type === 'removed'
                ? theme.destructive
                : theme.foreground;

        return (
            <View key={index} style={lineStyle}>
                <Caption style={styles.lineNumber}>{line.lineNumber}</Caption>
                <View style={styles.diffIcon}>
                    {line.type === 'added' && <Plus size={12} color={theme.primary} />}
                    {line.type === 'removed' && <Minus size={12} color={theme.destructive} />}
                </View>
                <Body style={[styles.diffContent, { color: contentColor }]}>
                    {line.content || ' '}
                </Body>
            </View>
        );
    };

    const renderLoading = () => (
        <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Body style={{ color: theme.mutedForeground }}>
                Processing string replacement...
            </Body>
        </View>
    );

    const renderError = () => (
        <View style={styles.errorContainer}>
            <AlertTriangle size={48} color={theme.destructive} />
            <H4 style={{ color: theme.destructive }}>Cannot Extract Replacement Data</H4>
            <Body style={styles.errorText}>
                Could not extract the old string and new string from the content.
            </Body>
        </View>
    );

    const renderContent = () => {
        if (isStreaming) {
            return renderLoading();
        }

        if (!oldStr || !newStr) {
            return renderError();
        }

        return (
            <ScrollView style={styles.diffContainer}>
                {diff.map((line, index) => renderDiffLine(line, index))}
            </ScrollView>
        );
    };

    return (
        <View style={styles.container}>
            {(filePath || diff.length > 0) && renderFileHeader()}
            {renderContent()}
        </View>
    );
} 