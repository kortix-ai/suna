import React, { useState } from 'react';
import { View, Pressable, Modal, Platform, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Download, Loader2, FileType, FileText, FileCode, X } from 'lucide-react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import { API_URL, getAuthHeaders } from '@/api/config';

interface FileDownloadButtonProps {
  /** The file content to download/export */
  content: string;
  /** The file name (used to determine if it's markdown and for download naming) */
  fileName: string;
  /** Whether the component is disabled */
  disabled?: boolean;
  /** Custom class name for the button */
  className?: string;
}

export type ExportFormat = 'pdf' | 'docx' | 'html' | 'markdown' | 'text';

interface ExportOption {
  format: ExportFormat;
  label: string;
  icon: typeof FileType;
  description: string;
}

/**
 * A reusable file download button for mobile that:
 * - For markdown files: Shows a modal with PDF, Word, HTML, Markdown export options
 * - For other files: Shows a simple download button
 */
export function FileDownloadButton({
  content,
  fileName,
  disabled = false,
  className,
}: FileDownloadButtonProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);

  // Check if file is markdown
  const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';
  const isMarkdown = fileExtension === 'md' || fileExtension === 'markdown';

  // Export options for markdown files
  const exportOptions: ExportOption[] = [
    {
      format: 'pdf',
      label: 'PDF',
      icon: FileType,
      description: 'Portable Document Format',
    },
    {
      format: 'docx',
      label: 'Word',
      icon: FileText,
      description: 'Microsoft Word Document',
    },
    {
      format: 'html',
      label: 'HTML',
      icon: FileCode,
      description: 'Web Page',
    },
    {
      format: 'markdown',
      label: 'Markdown',
      icon: FileCode,
      description: 'Plain Text Markdown',
    },
  ];

  /**
   * Convert markdown to HTML (simple conversion)
   */
  const convertMarkdownToHtml = (markdown: string): string => {
    // Basic markdown to HTML conversion
    // For production, you might want to use a library like marked or markdown-it
    let html = markdown;

    // Headers
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Code blocks
    html = html.replace(/```([^`]+)```/g, '<pre><code>$1</code></pre>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Line breaks
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    // Wrap in paragraphs
    html = `<p>${html}</p>`;

    return html;
  };

  /**
   * Create a complete HTML document with styling
   */
  const createHtmlDocument = (content: string, title: string): string => {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      color: #1a1a1a;
      max-width: 720px;
      margin: 0 auto;
      padding: 48px 24px;
      background: #fff;
    }
    h1, h2, h3, h4, h5, h6 {
      font-weight: 600;
      line-height: 1.3;
      margin: 1.5em 0 0.75em 0;
    }
    h1 { font-size: 2em; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.4em; }
    h2 { font-size: 1.5em; }
    h3 { font-size: 1.25em; }
    p { margin: 1em 0; line-height: 1.7; }
    a { color: #0066cc; text-decoration: underline; }
    code {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 0.9em;
      background: #f4f4f5;
      padding: 0.15em 0.4em;
      border-radius: 4px;
    }
    pre {
      margin: 1.5em 0;
      padding: 1em;
      background: #f4f4f5;
      border-radius: 8px;
      overflow-x: auto;
    }
    pre code {
      background: none;
      padding: 0;
    }
  </style>
</head>
<body>
${content}
</body>
</html>`;
  };

  /**
   * Call backend API to convert HTML to PDF or DOCX
   */
  const callExportAPI = async (
    htmlContent: string,
    baseFileName: string,
    format: 'pdf' | 'docx'
  ): Promise<string | null> => {
    try {
      // Use backend API endpoint
      const endpoint = `${API_URL}/export/${format}`;

      console.log(`[FileDownloadButton] Calling ${format.toUpperCase()} export API:`, endpoint);

      // Get auth headers
      const authHeaders = await getAuthHeaders();

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          content: htmlContent,
          fileName: baseFileName,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Export failed' }));
        throw new Error(errorData.error || `Export failed with status ${response.status}`);
      }

      // Get the blob and save to file
      const blob = await response.blob();
      const fileUri = `${FileSystem.cacheDirectory}${baseFileName}.${format}`;

      // Convert blob to base64 and write to file
      const reader = new FileReader();
      return new Promise((resolve, reject) => {
        reader.onloadend = async () => {
          try {
            const base64data = (reader.result as string).split(',')[1];
            await FileSystem.writeAsStringAsync(fileUri, base64data, {
              encoding: FileSystem.EncodingType.Base64,
            });
            resolve(fileUri);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      console.error(`[FileDownloadButton] ${format.toUpperCase()} export API error:`, error);
      Alert.alert(
        'Export Failed',
        `Failed to export as ${format.toUpperCase()}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return null;
    }
  };

  /**
   * Handle export to different formats
   */
  const handleExport = async (format: ExportFormat) => {
    if (!content || isExporting) return;

    setIsExporting(true);
    setExportingFormat(format);

    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      const baseFileName = fileName.replace(/\.(md|markdown)$/i, '');
      let fileUri = '';
      let mimeType = 'application/octet-stream';
      let exportFileName = fileName;

      switch (format) {
        case 'markdown': {
          // Export as plain markdown
          exportFileName = `${baseFileName}.md`;
          fileUri = `${FileSystem.cacheDirectory}${exportFileName}`;
          await FileSystem.writeAsStringAsync(fileUri, content);
          mimeType = 'text/markdown';
          break;
        }

        case 'html': {
          // Convert markdown to HTML and export
          const htmlContent = isMarkdown ? convertMarkdownToHtml(content) : content;
          const fullHtml = createHtmlDocument(htmlContent, baseFileName);
          exportFileName = `${baseFileName}.html`;
          fileUri = `${FileSystem.cacheDirectory}${exportFileName}`;
          await FileSystem.writeAsStringAsync(fileUri, fullHtml);
          mimeType = 'text/html';
          break;
        }

        case 'pdf': {
          // Call API for PDF conversion
          const htmlContent = isMarkdown ? convertMarkdownToHtml(content) : content;
          const convertedUri = await callExportAPI(htmlContent, baseFileName, 'pdf');

          if (!convertedUri) {
            setIsExporting(false);
            setExportingFormat(null);
            setShowExportModal(false);
            return;
          }

          fileUri = convertedUri;
          exportFileName = `${baseFileName}.pdf`;
          mimeType = 'application/pdf';
          break;
        }

        case 'docx': {
          // Call API for DOCX conversion
          const htmlContent = isMarkdown ? convertMarkdownToHtml(content) : content;
          const convertedUri = await callExportAPI(htmlContent, baseFileName, 'docx');

          if (!convertedUri) {
            setIsExporting(false);
            setExportingFormat(null);
            setShowExportModal(false);
            return;
          }

          fileUri = convertedUri;
          exportFileName = `${baseFileName}.docx`;
          mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          break;
        }

        case 'text':
        default: {
          // Export as-is
          fileUri = `${FileSystem.cacheDirectory}${fileName}`;
          await FileSystem.writeAsStringAsync(fileUri, content);
          mimeType = 'text/plain';
          break;
        }
      }

      // Share the file
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(fileUri, {
          mimeType,
          dialogTitle: `Export ${exportFileName}`,
          UTI: mimeType,
        });
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (error) {
      console.error('[FileDownloadButton] Export error:', error);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        'Export Failed',
        `Failed to export file: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      setTimeout(() => setIsExporting(false), 500);
    }
  };

  /**
   * Handle direct download (for non-markdown files)
   */
  const handleDirectDownload = async () => {
    if (!content || isExporting) return;

    setIsExporting(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(fileUri, content);

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(fileUri, {
          dialogTitle: `Download ${fileName}`,
        });
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (error) {
      console.error('[FileDownloadButton] Download error:', error);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setTimeout(() => setIsExporting(false), 500);
    }
  };

  // For markdown files, show button that opens modal
  if (isMarkdown) {
    return (
      <>
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setShowExportModal(true);
          }}
          disabled={disabled || isExporting || !content}
          className={`h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70 ${disabled || isExporting || !content ? 'opacity-50' : ''} ${className || ''}`}
        >
          <Icon
            as={isExporting ? Loader2 : Download}
            size={17}
            className="text-primary"
          />
        </Pressable>

        {/* Export Options Modal */}
        <Modal
          visible={showExportModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowExportModal(false)}
        >
          <Pressable
            className="flex-1 bg-black/50 items-center justify-center p-6"
            onPress={() => setShowExportModal(false)}
          >
            <Pressable
              className="bg-card rounded-2xl w-full max-w-md overflow-hidden border border-border"
              onPress={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <View className="flex-row items-center justify-between p-4 border-b border-border">
                <View>
                  <Text className="text-lg font-roobert-semibold text-primary">
                    Export Options
                  </Text>
                  <Text className="text-xs text-primary opacity-50 mt-0.5">
                    Choose export format
                  </Text>
                </View>
                <Pressable
                  onPress={() => setShowExportModal(false)}
                  className="h-8 w-8 items-center justify-center rounded-lg bg-card active:opacity-70"
                >
                  <Icon as={X} size={18} className="text-primary" />
                </Pressable>
              </View>

              {/* Export Options */}
              <View className="p-2">
                {exportOptions.map((option) => (
                  <Pressable
                    key={option.format}
                    onPress={() => handleExport(option.format)}
                    disabled={isExporting}
                    className={`flex-row items-center p-3 rounded-xl active:bg-primary/5 mb-1 ${isExporting ? 'opacity-50' : ''}`}
                  >
                    <View className="h-10 w-10 items-center justify-center rounded-lg bg-primary/10 mr-3">
                      {isExporting && exportingFormat === option.format ? (
                        <Icon
                          as={Loader2}
                          size={20}
                          className="text-primary"
                        />
                      ) : (
                        <Icon
                          as={option.icon}
                          size={20}
                          className="text-primary"
                        />
                      )}
                    </View>
                    <View className="flex-1">
                      <Text className="text-sm font-roobert-medium text-primary">
                        {option.label}
                      </Text>
                      <Text className="text-xs text-primary opacity-50 mt-0.5">
                        {isExporting && exportingFormat === option.format
                          ? 'Exporting...'
                          : option.description}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>

              {/* Note */}
              <View className="p-4 bg-primary/5 border-t border-border">
                <Text className="text-xs text-primary opacity-70 text-center">
                  Files will be saved to your device and can be shared
                </Text>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      </>
    );
  }

  // For non-markdown files, show simple download button
  return (
    <Pressable
      onPress={handleDirectDownload}
      disabled={disabled || isExporting || !content}
      className={`h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70 ${disabled || isExporting || !content ? 'opacity-50' : ''} ${className || ''}`}
    >
      <Icon
        as={isExporting ? Loader2 : Download}
        size={17}
        className="text-primary"
      />
    </Pressable>
  );
}

