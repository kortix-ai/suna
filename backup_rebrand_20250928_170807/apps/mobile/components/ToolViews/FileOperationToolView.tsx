import { Ionicons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useTheme } from '../../hooks/useThemeColor';
import { CodeRenderer, CsvRenderer, HtmlRenderer, MarkdownRenderer } from '../renderers';
import { Card, CardContent } from '../ui/Card';
import { TabSwitcher } from '../ui/TabSwitcher';
import { useToolViewContext } from './ToolViewContext';
import { ToolViewProps } from './ToolViewRegistry';

interface FileOperationToolViewProps extends ToolViewProps {
    assistantContent?: string;
    toolContent?: string;
    assistantTimestamp?: string;
    toolTimestamp?: string;
    project?: any;
}

const getOperationConfigs = () => ({
    create: {
        icon: 'add-circle' as const,
        color: '#22c55e',
        bgColor: '#dcfce7',
        progressMessage: 'Creating file...'
    },
    edit: {
        icon: 'create' as const,
        color: '#3b82f6',
        bgColor: '#dbeafe',
        progressMessage: 'Editing file...'
    },
    delete: {
        icon: 'trash' as const,
        color: '#ef4444',
        bgColor: '#fee2e2',
        progressMessage: 'Deleting file...'
    },
    read: {
        icon: 'document-text' as const,
        color: '#8b5cf6',
        bgColor: '#f3e8ff',
        progressMessage: 'Reading file...'
    }
});

const getFileExtension = (filename: string) => {
    const lastDot = filename.lastIndexOf('.');
    return lastDot > 0 ? filename.substring(lastDot + 1).toLowerCase() : '';
};

const getLanguageFromFileName = (filename: string) => {
    const ext = getFileExtension(filename);
    const langMap: { [key: string]: string } = {
        'js': 'javascript',
        'jsx': 'javascript',
        'ts': 'typescript',
        'tsx': 'typescript',
        'py': 'python',
        'java': 'java',
        'cpp': 'cpp',
        'c': 'c',
        'cs': 'csharp',
        'php': 'php',
        'rb': 'ruby',
        'go': 'go',
        'rs': 'rust',
        'swift': 'swift',
        'kt': 'kotlin',
        'dart': 'dart',
        'html': 'html',
        'css': 'css',
        'scss': 'scss',
        'sass': 'sass',
        'less': 'less',
        'json': 'json',
        'xml': 'xml',
        'yaml': 'yaml',
        'yml': 'yaml',
        'toml': 'toml',
        'md': 'markdown',
        'sql': 'sql',
        'sh': 'bash',
        'bash': 'bash',
        'zsh': 'zsh',
        'fish': 'fish'
    };
    return langMap[ext] || 'text';
};

const isFileType = {
    markdown: (ext: string) => ['md', 'markdown'].includes(ext),
    html: (ext: string) => ['html', 'htm'].includes(ext),
    csv: (ext: string) => ['csv'].includes(ext),
    code: (ext: string) => ['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'cpp', 'c', 'cs', 'php', 'rb', 'go', 'rs', 'swift', 'kt', 'dart'].includes(ext),
    data: (ext: string) => ['json', 'xml', 'yaml', 'yml', 'toml'].includes(ext)
};

const getFileIcon = (filename: string) => {
    const ext = getFileExtension(filename);

    if (isFileType.markdown(ext)) return 'reader';
    if (isFileType.html(ext)) return 'globe';
    if (isFileType.csv(ext)) return 'grid';
    if (isFileType.code(ext)) return 'code-slash';
    if (isFileType.data(ext)) return 'document-text';

    return 'document-text';
};

const extractFileOperationData = (toolCall?: any, toolContent?: string) => {
    let filePath = '';
    let fileContent = '';
    let operation = 'edit';
    let isSuccess = true;
    let errorMessage = '';

    // Extract from tool call parameters
    if (toolCall?.parameters) {
        filePath = toolCall.parameters.target_file ||
            toolCall.parameters.file_path ||
            toolCall.parameters.path ||
            toolCall.parameters.filename || '';

        fileContent = toolCall.parameters.code_edit ||
            toolCall.parameters.content ||
            toolCall.parameters.file_content ||
            toolCall.parameters.file_contents || '';

        // Determine operation from tool name
        const toolName = toolCall.name || '';
        if (toolName.includes('create') || toolName.includes('new')) {
            operation = 'create';
        } else if (toolName.includes('delete') || toolName.includes('remove')) {
            operation = 'delete';
        } else if (toolName.includes('read') || toolName.includes('view')) {
            operation = 'read';
        }
    }

    // Parse tool content if available
    if (toolContent) {
        try {
            const parsed = JSON.parse(toolContent);

            if (parsed.tool_execution) {
                const toolExecution = parsed.tool_execution;

                // Determine operation from XML tag name
                const xmlTagName = toolExecution.xml_tag_name || '';
                if (xmlTagName.includes('create')) {
                    operation = 'create';
                } else if (xmlTagName.includes('delete')) {
                    operation = 'delete';
                } else if (xmlTagName.includes('read')) {
                    operation = 'read';
                } else if (xmlTagName.includes('replace') || xmlTagName.includes('rewrite')) {
                    operation = 'edit';
                }

                // Extract arguments
                if (toolExecution.arguments) {
                    filePath = toolExecution.arguments.target_file ||
                        toolExecution.arguments.file_path ||
                        toolExecution.arguments.path ||
                        toolExecution.arguments.filename || filePath;

                    fileContent = toolExecution.arguments.code_edit ||
                        toolExecution.arguments.content ||
                        toolExecution.arguments.file_content ||
                        toolExecution.arguments.file_contents || fileContent;
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

                    // For read operations, content might be in result
                    if (operation === 'read' && result.content) {
                        fileContent = result.content;
                    }
                }
            }
        } catch (e) {
            // If parsing fails, treat as raw content
            if (operation === 'read') {
                fileContent = toolContent;
            }
        }
    }

    return {
        filePath,
        fileContent,
        operation,
        isSuccess,
        errorMessage
    };
};

export function FileOperationToolView({
    name,
    toolCall,
    toolContent,
    isStreaming = false,
    isSuccess = true,
    ...props
}: FileOperationToolViewProps) {
    const theme = useTheme();
    const { currentView, setCurrentView, setHeaderExtensions } = useToolViewContext();

    // Convert color-mix(in oklab, var(--muted) 20%, transparent) to hex
    const mutedBg = theme.muted === '#e8e8e8' ? '#e8e8e833' : '#30303033';

    console.log('📁 FILE OPERATION TOOL RECEIVED:', !!toolContent, toolContent?.length || 0);

    const {
        filePath,
        fileContent,
        operation,
        isSuccess: actualIsSuccess,
        errorMessage
    } = extractFileOperationData(toolCall, toolContent);

    const fileName = filePath.split('/').pop() || '';
    const fileExtension = getFileExtension(fileName);
    const language = getLanguageFromFileName(fileName);
    const FileIcon = getFileIcon(fileName);

    const isMarkdown = isFileType.markdown(fileExtension);
    const isHtml = isFileType.html(fileExtension);
    const isCsv = isFileType.csv(fileExtension);

    // Register header extensions for preview/source tabs
    useEffect(() => {
        if (operation !== 'delete' && fileContent) {
            const tabs = [
                { id: 'preview', label: 'Preview', icon: 'eye' as const },
                { id: 'source', label: 'Source', icon: 'code' as const }
            ];

            setHeaderExtensions(
                <TabSwitcher
                    tabs={tabs}
                    activeTab={currentView}
                    onTabChange={(tabId) => setCurrentView(tabId as 'preview' | 'source')}
                />
            );
        } else {
            setHeaderExtensions(null);
        }

        // Cleanup on unmount
        return () => {
            setHeaderExtensions(null);
        };
    }, [operation, fileContent, currentView, setHeaderExtensions, setCurrentView]);

    if (!toolContent && !isStreaming) {
        console.log('❌ FILE OPERATION TOOL: NO CONTENT');
        return (
            <View style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                padding: 20,
                backgroundColor: theme.background,
            }}>
                <Text style={{
                    color: theme.mutedForeground,
                    fontSize: 16,
                    textAlign: 'center',
                }}>
                    No file operation data available
                </Text>
            </View>
        );
    }

    const configs = getOperationConfigs();
    const config = configs[operation as keyof typeof configs] || configs.edit;
    const IconComponent = config.icon;

    const renderLoadingState = () => (
        <View style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 48,
            backgroundColor: theme.card,
        }}>
            <View style={{
                width: 80,
                height: 80,
                borderRadius: 40,
                backgroundColor: config.bgColor,
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 24
            }}>
                <ActivityIndicator
                    size="large"
                    color={config.color}
                />
            </View>
            <Text style={{
                fontSize: 18,
                fontWeight: '600',
                color: theme.foreground,
                textAlign: 'center',
                marginBottom: 8
            }}>
                {config.progressMessage}
            </Text>
            <Text style={{
                fontSize: 14,
                color: theme.mutedForeground,
                textAlign: 'center',
                fontFamily: 'monospace'
            }}>
                {filePath || 'Processing file...'}
            </Text>
        </View>
    );

    const renderDeleteOperation = () => (
        <View style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 48,
            backgroundColor: theme.card,
        }}>
            <View style={{
                width: 80,
                height: 80,
                borderRadius: 40,
                backgroundColor: config.bgColor,
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 24
            }}>
                <Ionicons
                    name={IconComponent}
                    size={40}
                    color={config.color}
                />
            </View>
            <Text style={{
                fontSize: 20,
                fontWeight: '600',
                color: theme.foreground,
                textAlign: 'center',
                marginBottom: 16
            }}>
                File Deleted
            </Text>
            <Card
                style={{
                    backgroundColor: mutedBg,
                    borderColor: theme.muted,
                    width: '100%',
                    maxWidth: 300
                }}
                bordered
                elevated={false}
            >
                <CardContent style={{ padding: 16 }}>
                    <Text style={{
                        fontSize: 14,
                        color: theme.foreground,
                        fontFamily: 'monospace',
                        textAlign: 'center'
                    }}>
                        {filePath || 'Unknown file path'}
                    </Text>
                </CardContent>
            </Card>
            <Text style={{
                fontSize: 14,
                color: theme.mutedForeground,
                textAlign: 'center',
                marginTop: 16
            }}>
                This file has been permanently removed
            </Text>
        </View>
    );

    const renderPreview = () => {
        if (!fileContent) {
            return (
                <View style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    padding: 32,
                    backgroundColor: theme.card,
                }}>
                    <Ionicons
                        name={FileIcon}
                        size={48}
                        color={theme.mutedForeground}
                        style={{ marginBottom: 16 }}
                    />
                    <Text style={{
                        fontSize: 16,
                        color: theme.mutedForeground,
                        textAlign: 'center'
                    }}>
                        No content to preview
                    </Text>
                </View>
            );
        }

        if (isMarkdown) {
            return (
                <View style={{
                    flex: 1,
                    paddingHorizontal: 10,
                }}>
                    <MarkdownRenderer
                        content={fileContent}
                        style={{ flex: 1 }}
                        noScrollView={true}
                    />
                </View>
            );
        }

        if (isHtml) {
            return (
                <HtmlRenderer
                    content={fileContent}
                    style={{ flex: 1 }}
                />
            );
        }

        if (isCsv) {
            return (
                <CsvRenderer
                    content={fileContent}
                    style={{ flex: 1 }}
                />
            );
        }

        return (
            <View style={{
                flex: 1,
                backgroundColor: mutedBg,
                padding: 24,
            }}>
                <Text style={{
                    fontSize: 14,
                    color: theme.foreground,
                    fontFamily: 'monospace',
                    lineHeight: 20
                }}>
                    {fileContent}
                </Text>
            </View>
        );
    };

    const renderSource = () => {
        if (!fileContent) {
            return (
                <View style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    padding: 32,
                    backgroundColor: theme.card,
                }}>
                    <Ionicons
                        name={FileIcon}
                        size={48}
                        color={theme.mutedForeground}
                        style={{ marginBottom: 16 }}
                    />
                    <Text style={{
                        fontSize: 16,
                        color: theme.mutedForeground,
                        textAlign: 'center'
                    }}>
                        No source code to display
                    </Text>
                </View>
            );
        }

        return (
            <CodeRenderer
                content={fileContent}
                language={language}
                showLineNumbers={true}
                style={{ flex: 1 }}
            />
        );
    };

    return (
        <View style={{ flex: 1 }}>
            {isStreaming && !fileContent ? (
                renderLoadingState()
            ) : operation === 'delete' ? (
                renderDeleteOperation()
            ) : currentView === 'preview' ? (
                renderPreview()
            ) : (
                renderSource()
            )}
            {isStreaming && fileContent && (
                <View style={{
                    position: 'absolute',
                    bottom: 16,
                    right: 16,
                    backgroundColor: config.color,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 16,
                    flexDirection: 'row',
                    alignItems: 'center'
                }}>
                    <ActivityIndicator
                        size="small"
                        color="white"
                        style={{ marginRight: 6 }}
                    />
                    <Text style={{
                        fontSize: 12,
                        color: 'white',
                        fontWeight: '600'
                    }}>
                        Streaming...
                    </Text>
                </View>
            )}
        </View>
    );
} 