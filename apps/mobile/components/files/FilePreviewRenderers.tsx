/**
 * File Preview Renderers
 * Components for previewing different file types
 */

import React, { useState, useMemo } from 'react';
import { View, Image, ScrollView, Dimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui';
import { AlertCircle, FileText } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import Markdown from 'react-native-markdown-display';
import { markdownStyles, markdownStylesDark } from '@/lib/utils/markdown-styles';
// @ts-ignore - no types available
import SyntaxHighlighter from 'react-native-syntax-highlighter';
// @ts-ignore - no types available  
import { atomOneDark, atomOneLight } from 'react-syntax-highlighter/dist/esm/styles/hljs';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

/**
 * Constructs a preview URL for HTML files in the sandbox environment.
 * Properly handles URL encoding of file paths by encoding each path segment individually.
 */
function constructHtmlPreviewUrl(
  sandboxUrl: string | undefined,
  filePath: string | undefined,
): string | undefined {
  if (!sandboxUrl || !filePath) {
    return undefined;
  }

  // Remove /workspace/ prefix if present
  const processedPath = filePath.replace(/^\/workspace\//, '');

  // Split the path into segments and encode each segment individually
  const pathSegments = processedPath
    .split('/')
    .map((segment) => encodeURIComponent(segment));

  // Join the segments back together with forward slashes
  const encodedPath = pathSegments.join('/');

  return `${sandboxUrl}/${encodedPath}`;
}

// File preview type enum
export enum FilePreviewType {
  IMAGE = 'image',
  PDF = 'pdf',
  MARKDOWN = 'markdown',
  CSV = 'csv',
  XLSX = 'xlsx',
  HTML = 'html',
  JSON = 'json',
  CODE = 'code',
  TEXT = 'text',
  BINARY = 'binary',
  OTHER = 'other',
}

// Helper to get file preview type
export function getFilePreviewType(filename: string): FilePreviewType {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif', 'tiff'];
  const documentExtensions = ['pdf'];
  const markdownExtensions = ['md', 'markdown', 'mdx'];
  const csvExtensions = ['csv', 'tsv'];
  const xlsxExtensions = ['xlsx', 'xls'];
  const htmlExtensions = ['html', 'htm'];
  const jsonExtensions = ['json', 'jsonc', 'json5'];
  const codeExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
    'cs', 'rb', 'go', 'rs', 'php', 'swift', 'kt', 'scala', 'r',
    'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'css', 'scss', 'sass', 'less', 'styl',
    'yaml', 'yml', 'toml', 'ini', 'conf', 'config',
    'dart', 'lua', 'perl', 'vim', 'dockerfile', 'makefile',
  ];
  const textExtensions = ['txt', 'log', 'md', 'rtf', 'tex'];
  const binaryExtensions = ['zip', 'tar', 'gz', 'rar', '7z', 'exe', 'dmg', 'pkg', 'deb', 'rpm'];
  
  if (imageExtensions.includes(ext)) return FilePreviewType.IMAGE;
  if (documentExtensions.includes(ext)) return FilePreviewType.PDF;
  if (markdownExtensions.includes(ext)) return FilePreviewType.MARKDOWN;
  if (csvExtensions.includes(ext)) return FilePreviewType.CSV;
  if (xlsxExtensions.includes(ext)) return FilePreviewType.XLSX;
  if (htmlExtensions.includes(ext)) return FilePreviewType.HTML;
  if (jsonExtensions.includes(ext)) return FilePreviewType.JSON;
  if (codeExtensions.includes(ext)) return FilePreviewType.CODE;
  if (textExtensions.includes(ext)) return FilePreviewType.TEXT;
  if (binaryExtensions.includes(ext)) return FilePreviewType.BINARY;
  
  return FilePreviewType.OTHER;
}

// Helper to get language for syntax highlighting
export function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  
  const languageMap: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'rb': 'ruby',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
    'php': 'php',
    'swift': 'swift',
    'kt': 'kotlin',
    'scala': 'scala',
    'r': 'r',
    'sql': 'sql',
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'fish': 'bash',
    'ps1': 'powershell',
    'bat': 'batch',
    'cmd': 'batch',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    'html': 'html',
    'xml': 'xml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'json': 'json',
    'md': 'markdown',
    'dart': 'dart',
    'lua': 'lua',
    'perl': 'perl',
  };
  
  return languageMap[ext] || 'text';
}

interface FilePreviewProps {
  content: string | Blob | null;
  fileName: string;
  previewType: FilePreviewType;
  blobUrl?: string;
  filePath?: string;
  sandboxUrl?: string;
}

/**
 * Image Preview Component
 */
function ImagePreview({ blobUrl, fileName }: { blobUrl?: string; fileName: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });

  if (!blobUrl) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <KortixLoader size="large" />
        <Text className="text-sm text-muted-foreground mt-4">
          Loading image...
        </Text>
      </View>
    );
  }

  return (
    <ScrollView 
      className="flex-1"
      contentContainerStyle={{ padding: 16 }}
      showsVerticalScrollIndicator={false}
      style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}
    >
      {hasError ? (
        <View className="items-center justify-center p-8">
          <Icon
            as={AlertCircle}
            size={48}
            className="text-destructive mb-4"
            strokeWidth={1.5}
          />
          <Text className="text-sm text-muted-foreground text-center">
            Failed to load image
          </Text>
        </View>
      ) : (
        <View className="items-center">
          {isLoading && (
            <View className="absolute inset-0 items-center justify-center z-10">
              <KortixLoader size="large" />
            </View>
          )}
          <Image
            source={{ uri: blobUrl }}
            style={{
              width: imageSize.width || SCREEN_WIDTH - 32,
              height: imageSize.height || 300,
            }}
            resizeMode="contain"
            onLoad={(event) => {
              const { width, height } = event.nativeEvent.source;
              const aspectRatio = width / height;
              const maxWidth = SCREEN_WIDTH - 32;
              const calculatedHeight = maxWidth / aspectRatio;
              
              setImageSize({
                width: maxWidth,
                height: calculatedHeight,
              });
              setIsLoading(false);
            }}
            onError={() => {
              setIsLoading(false);
              setHasError(true);
            }}
          />
        </View>
      )}
    </ScrollView>
  );
}

/**
 * Markdown Preview Component
 */
function MarkdownPreview({ content }: { content: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <ScrollView 
      className="flex-1 px-4 py-4"
      showsVerticalScrollIndicator={true}
      style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}
    >
      <Markdown style={isDark ? markdownStylesDark : markdownStyles}>
        {content}
      </Markdown>
    </ScrollView>
  );
}

/**
 * JSON Preview Component with syntax highlighting
 */
function JsonPreview({ content }: { content: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // Format JSON for better readability
  const formattedJson = useMemo(() => {
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return content;
    }
  }, [content]);

  return (
    <ScrollView 
      className="flex-1"
      showsVerticalScrollIndicator={true}
      style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}
    >
      <View className="px-4 py-3 border-b" style={{
        borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
      }}>
        <Text 
          className="text-xs font-roobert-medium"
          style={{ 
            color: isDark ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
          }}
        >
          JSON
        </Text>
      </View>
      <View className="px-2 py-2">
        <SyntaxHighlighter
          language="json"
          style={isDark ? atomOneDark : atomOneLight}
          customStyle={{
            backgroundColor: 'transparent',
            padding: 12,
            margin: 0,
            fontSize: 13,
            lineHeight: 20,
          }}
          highlighter="hljs"
        >
          {formattedJson}
        </SyntaxHighlighter>
      </View>
    </ScrollView>
  );
}

/**
 * Code Preview Component with syntax highlighting
 */
function CodePreview({ content, fileName }: { content: string; fileName: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const language = getLanguageFromFilename(fileName);

  return (
    <ScrollView 
      className="flex-1"
      showsVerticalScrollIndicator={true}
      style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}
    >
      <View className="px-4 py-3 border-b" style={{
        borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
      }}>
        <Text 
          className="text-xs font-roobert-medium"
          style={{ 
            color: isDark ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
          }}
        >
          {language.toUpperCase()}
        </Text>
      </View>
      <View className="px-2 py-2">
        <SyntaxHighlighter
          language={language}
          style={isDark ? atomOneDark : atomOneLight}
          customStyle={{
            backgroundColor: 'transparent',
            padding: 12,
            margin: 0,
            fontSize: 13,
            lineHeight: 20,
          }}
          highlighter="hljs"
        >
          {content}
        </SyntaxHighlighter>
      </View>
    </ScrollView>
  );
}
/**
 * HTML Preview Component with Daytona iframe
 */
function HtmlPreview({ 
  content, 
  filePath, 
  sandboxUrl 
}: { 
  content: string; 
  filePath?: string;
  sandboxUrl?: string;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // If we have sandbox URL and file path, use Daytona iframe to preview
  const htmlPreviewUrl = constructHtmlPreviewUrl(sandboxUrl, filePath);
  
  if (htmlPreviewUrl) {
    return (
      <View className="flex-1">
        <WebView
          source={{ uri: htmlPreviewUrl }}
          style={{ flex: 1, backgroundColor: isDark ? '#121215' : '#ffffff' }}
          originWhitelist={['*']}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          startInLoadingState={true}
          renderLoading={() => (
            <View className="flex-1 items-center justify-center">
              <KortixLoader size="large" />
              <Text 
                className="text-sm mt-4 font-roobert"
                style={{ color: isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
              >
                Loading preview...
              </Text>
            </View>
          )}
        />
      </View>
    );
  }
  
  // Fallback: Show as text if no sandbox URL available
  return <TextPreview content={content} />;
}

/**
 * Text Preview Component
 */
function TextPreview({ content }: { content: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <ScrollView 
      className="flex-1 px-4 py-4"
      showsVerticalScrollIndicator={true}
      style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}
    >
      <Text
        style={{
          color: isDark ? '#f8f8f8' : '#121215',
          fontFamily: 'monospace',
          fontSize: 13,
          lineHeight: 20,
        }}
        selectable
      >
        {content}
      </Text>
    </ScrollView>
  );
}

/**
 * CSV Preview Component (Simple Table View)
 */
function CsvPreview({ content }: { content: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // Parse CSV content
  const rows = content.split('\n').filter(row => row.trim());
  const headers = rows[0]?.split(',').map(h => h.trim()) || [];
  const dataRows = rows.slice(1);

  return (
    <ScrollView 
      horizontal
      showsHorizontalScrollIndicator={true}
      className="flex-1"
      style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}
    >
      <ScrollView 
        showsVerticalScrollIndicator={true}
        className="px-4 py-4"
        style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}
      >
        {/* Headers */}
        <View className="flex-row border-b pb-2 mb-2"
          style={{
            borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
          }}
        >
          {headers.map((header, index) => (
            <View 
              key={index} 
              style={{ width: 120, marginRight: 12 }}
            >
              <Text
                style={{ color: isDark ? '#f8f8f8' : '#121215' }}
                className="text-xs font-roobert-semibold"
                numberOfLines={1}
              >
                {header}
              </Text>
            </View>
          ))}
        </View>

        {/* Data Rows */}
        {dataRows.slice(0, 100).map((row, rowIndex) => {
          const cells = row.split(',').map(c => c.trim());
          return (
            <View 
              key={rowIndex} 
              className="flex-row py-2 border-b"
              style={{
                borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.05)',
              }}
            >
              {cells.map((cell, cellIndex) => (
                <View 
                  key={cellIndex} 
                  style={{ width: 120, marginRight: 12 }}
                >
                  <Text
                    style={{ color: isDark ? 'rgba(248, 248, 248, 0.8)' : 'rgba(18, 18, 21, 0.8)' }}
                    className="text-xs font-roobert"
                    numberOfLines={2}
                  >
                    {cell}
                  </Text>
                </View>
              ))}
            </View>
          );
        })}

        {dataRows.length > 100 && (
          <Text className="text-xs text-muted-foreground text-center mt-4">
            Showing first 100 rows of {dataRows.length}
          </Text>
        )}
      </ScrollView>
    </ScrollView>
  );
}

/**
 * Fallback Preview Component
 */
function FallbackPreview({ fileName, previewType }: { fileName: string; previewType: FilePreviewType }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  let message = 'Preview not available';
  if (previewType === FilePreviewType.PDF) {
    message = 'PDF preview requires download';
  } else if (previewType === FilePreviewType.XLSX) {
    message = 'Spreadsheet preview requires download';
  }

  return (
    <View className="flex-1 items-center justify-center p-8">
      <Icon
        as={FileText}
        size={48}
        color={isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.3)'}
        strokeWidth={1.5}
        className="mb-4"
      />
      <Text className="text-sm font-roobert-medium text-center mb-2">
        {fileName}
      </Text>
      <Text className="text-xs text-muted-foreground text-center">
        {message}
      </Text>
    </View>
  );
}

/**
 * Main File Preview Component
 */
export function FilePreview({ 
  content, 
  fileName, 
  previewType, 
  blobUrl, 
  filePath,
  sandboxUrl 
}: FilePreviewProps) {
  // For images, we need the blob URL
  if (previewType === FilePreviewType.IMAGE) {
    return <ImagePreview blobUrl={blobUrl} fileName={fileName} />;
  }

  // For other types, we need text content
  if (!content || typeof content !== 'string') {
    return <FallbackPreview fileName={fileName} previewType={previewType} />;
  }

  switch (previewType) {
    case FilePreviewType.MARKDOWN:
      return <MarkdownPreview content={content} />;
    
    case FilePreviewType.HTML:
      return <HtmlPreview content={content} filePath={filePath} sandboxUrl={sandboxUrl} />;
    
    case FilePreviewType.JSON:
      return <JsonPreview content={content} />;
    
    case FilePreviewType.CODE:
      return <CodePreview content={content} fileName={fileName} />;
    
    case FilePreviewType.TEXT:
      return <TextPreview content={content} />;
    
    case FilePreviewType.CSV:
      return <CsvPreview content={content} />;
    
    case FilePreviewType.PDF:
    case FilePreviewType.XLSX:
    case FilePreviewType.BINARY:
    default:
      return <FallbackPreview fileName={fileName} previewType={previewType} />;
  }
}

