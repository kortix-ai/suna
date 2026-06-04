/**
 * File Preview Renderers
 * Components for previewing different file types
 */

import React, { useState, useMemo, useEffect } from 'react';
import { View, Image, ScrollView, Dimensions, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui';
import { AlertCircle, FileText } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SelectableMarkdownText } from '@/components/ui/selectable-markdown';
import { autoLinkUrls } from '@agentpress/shared';
import * as FileSystem from 'expo-file-system/legacy';
import { log } from '@/lib/logger';

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
  DOCX = 'docx',
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
  const docxExtensions = ['docx'];
  const htmlExtensions = ['html', 'htm'];
  const jsonExtensions = ['json', 'jsonc', 'json5'];
  const codeExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'py', 'pyi', 'pyx', 'pyw',
    'java', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx', 'm', 'mm',
    'cs', 'rb', 'erb', 'go', 'rs', 'php', 'swift', 'kt', 'kts', 'scala',
    'r', 'rmd', 'hs', 'lhs', 'lua', 'perl', 'pl', 'pm',
    'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'css', 'scss', 'sass', 'less', 'styl',
    'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'cfg', 'properties',
    'xml', 'xsl', 'xslt', 'wsdl',
    'dart', 'vim', 'dockerfile', 'makefile',
    'vue', 'svelte',
    'proto', 'graphql', 'gql',
    'gradle', 'groovy', 'clj', 'cljs', 'ex', 'exs',
    'f90', 'f95', 'f03', 'for',
    'zig', 'nim', 'v', 'cr', 'jl',
    'env', 'gitignore', 'editorconfig',
  ];
  const textExtensions = ['txt', 'log', 'rtf', 'tex', 'rst', 'org', 'nfo', 'info'];
  const binaryExtensions = ['zip', 'tar', 'gz', 'rar', '7z', 'exe', 'dmg', 'pkg', 'deb', 'rpm'];

  if (imageExtensions.includes(ext)) return FilePreviewType.IMAGE;
  if (documentExtensions.includes(ext)) return FilePreviewType.PDF;
  if (markdownExtensions.includes(ext)) return FilePreviewType.MARKDOWN;
  if (csvExtensions.includes(ext)) return FilePreviewType.CSV;
  if (xlsxExtensions.includes(ext)) return FilePreviewType.XLSX;
  if (docxExtensions.includes(ext)) return FilePreviewType.DOCX;
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
    'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
    'ts': 'typescript', 'tsx': 'typescript',
    'py': 'python', 'pyi': 'python', 'pyx': 'python', 'pyw': 'python',
    'rb': 'ruby', 'erb': 'ruby', 'gemspec': 'ruby',
    'java': 'java',
    'c': 'c', 'h': 'c', 'm': 'objectivec',
    'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp', 'hxx': 'cpp', 'mm': 'objectivec',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
    'php': 'php',
    'swift': 'swift',
    'kt': 'kotlin', 'kts': 'kotlin',
    'scala': 'scala',
    'r': 'r', 'rmd': 'r',
    'hs': 'haskell', 'lhs': 'haskell',
    'lua': 'lua',
    'perl': 'perl', 'pl': 'perl', 'pm': 'perl',
    'sql': 'sql',
    'sh': 'bash', 'bash': 'bash', 'zsh': 'bash', 'fish': 'bash',
    'ps1': 'powershell', 'bat': 'dos', 'cmd': 'dos',
    'css': 'css', 'scss': 'scss', 'sass': 'scss', 'less': 'less',
    'html': 'html', 'htm': 'html',
    'xml': 'xml', 'xsl': 'xml', 'xslt': 'xml', 'wsdl': 'xml',
    'yaml': 'yaml', 'yml': 'yaml',
    'toml': 'ini', 'ini': 'ini', 'conf': 'ini', 'cfg': 'ini', 'properties': 'properties',
    'json': 'json', 'jsonc': 'json', 'json5': 'json',
    'md': 'markdown', 'mdx': 'markdown',
    'dart': 'dart',
    'vim': 'vim',
    'vue': 'xml', 'svelte': 'xml',
    'proto': 'protobuf', 'graphql': 'graphql', 'gql': 'graphql',
    'gradle': 'gradle', 'groovy': 'groovy',
    'clj': 'clojure', 'cljs': 'clojure',
    'ex': 'elixir', 'exs': 'elixir',
    'jl': 'julia',
    'zig': 'zig', 'nim': 'nim',
    'dockerfile': 'dockerfile', 'makefile': 'makefile',
  };

  return languageMap[ext] || 'plaintext';
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
      <SelectableMarkdownText isDark={isDark}>
        {autoLinkUrls(content)}
      </SelectableMarkdownText>
    </ScrollView>
  );
}

/**
 * JSON Preview Component with syntax highlighting
 */
function JsonPreview({ content }: { content: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  // Format JSON for better readability
  const formattedJson = useMemo(() => {
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return content;
    }
  }, [content]);

  const html = useMemo(
    () => generateHighlightedCodeHtml(formattedJson, 'json', isDark),
    [formattedJson, isDark],
  );

  return (
    <View className="flex-1" style={{ backgroundColor: isDark ? '#1e1e1e' : '#ffffff' }}>
      <WebView
        source={{ html }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        originWhitelist={['*']}
        javaScriptEnabled
        scrollEnabled
        showsVerticalScrollIndicator
        scalesPageToFit={false}
        bounces={false}
        startInLoadingState
        renderLoading={() => (
          <View
            className="absolute inset-0 items-center justify-center"
            style={{ backgroundColor: isDark ? '#1e1e1e' : '#ffffff' }}
          >
            <KortixLoader size="large" />
          </View>
        )}
      />
      {/* Language badge at bottom */}
      <View
        className="px-4 pt-3 border-t"
        style={{
          borderTopColor: isDark
            ? 'rgba(248, 248, 248, 0.08)'
            : 'rgba(18, 18, 21, 0.06)',
          backgroundColor: isDark ? '#121215' : '#ffffff',
          paddingBottom: Math.max(insets.bottom, 12),
        }}
      >
        <Text
          className="text-xs font-roobert-medium"
          style={{
            color: isDark
              ? 'rgba(248, 248, 248, 0.4)'
              : 'rgba(18, 18, 21, 0.4)',
          }}
        >
          JSON
        </Text>
      </View>
    </View>
  );
}

/**
 * Generates HTML with highlight.js for syntax-highlighted code rendering.
 */
function generateHighlightedCodeHtml(
  code: string,
  language: string,
  isDark: boolean,
): string {
  const bgColor = isDark ? '#1e1e1e' : '#ffffff';
  const theme = isDark ? 'github-dark' : 'github';
  const lineNumColor = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
  const lineNumBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  // Escape HTML entities in code
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/${theme}.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    background: ${bgColor};
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 20px;
    -webkit-text-size-adjust: none;
  }
  .code-wrapper {
    position: relative;
    display: flex;
    flex-direction: row;
    min-height: 100%;
  }
  .gutter {
    position: sticky;
    left: 0;
    z-index: 2;
    background: ${bgColor};
    flex-shrink: 0;
    padding: 12px 0;
    border-right: 1px solid ${lineNumBorder};
    user-select: none;
    -webkit-user-select: none;
  }
  .gutter-line {
    display: block;
    padding: 0 14px 0 16px;
    text-align: right;
    color: ${lineNumColor};
    font-size: 12px;
    line-height: 20px;
    min-width: 54px;
  }
  .code-area {
    flex: 1;
    padding: 12px 16px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .code-line {
    display: block;
    line-height: 20px;
    min-height: 20px;
    white-space: pre;
  }
</style>
</head>
<body>
<div class="code-wrapper">
  <div class="gutter" id="gutter"></div>
  <div class="code-area" id="code-area"></div>
</div>
<script>
  var codeStr = ${JSON.stringify(code)};
  var lang = ${JSON.stringify(language)};
  var highlighted;
  try {
    var result = hljs.highlight(codeStr, { language: lang, ignoreIllegals: true });
    highlighted = result.value;
  } catch(e) {
    highlighted = codeStr
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  var lines = highlighted.split('\\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  var gutter = document.getElementById('gutter');
  var codeArea = document.getElementById('code-area');

  for (var i = 0; i < lines.length; i++) {
    var num = document.createElement('span');
    num.className = 'gutter-line';
    num.textContent = String(i + 1);
    gutter.appendChild(num);

    var line = document.createElement('span');
    line.className = 'code-line';
    line.innerHTML = lines[i] || ' ';
    codeArea.appendChild(line);
  }
</script>
</body>
</html>`;
}

/**
 * Code Preview Component with syntax highlighting via highlight.js WebView.
 */
function CodePreview({ content, fileName }: { content: string; fileName: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const language = getLanguageFromFilename(fileName);

  const html = useMemo(
    () => generateHighlightedCodeHtml(content, language, isDark),
    [content, language, isDark],
  );

  return (
    <View className="flex-1" style={{ backgroundColor: isDark ? '#1e1e1e' : '#ffffff' }}>
      {/* Highlighted code */}
      <WebView
        source={{ html }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        originWhitelist={['*']}
        javaScriptEnabled
        scrollEnabled
        showsVerticalScrollIndicator
        scalesPageToFit={false}
        bounces={false}
        startInLoadingState
        renderLoading={() => (
          <View
            className="absolute inset-0 items-center justify-center"
            style={{ backgroundColor: isDark ? '#1e1e1e' : '#ffffff' }}
          >
            <KortixLoader size="large" />
          </View>
        )}
      />
      {/* Language badge at bottom */}
      <View
        className="px-4 pt-3 border-t"
        style={{
          borderTopColor: isDark
            ? 'rgba(248, 248, 248, 0.08)'
            : 'rgba(18, 18, 21, 0.06)',
          backgroundColor: isDark ? '#121215' : '#ffffff',
          paddingBottom: Math.max(insets.bottom, 12),
        }}
      >
        <Text
          className="text-xs font-roobert-medium"
          style={{
            color: isDark
              ? 'rgba(248, 248, 248, 0.4)'
              : 'rgba(18, 18, 21, 0.4)',
          }}
        >
          {language.toUpperCase()}
        </Text>
      </View>
    </View>
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
 * Generates HTML with embedded pdf.js for rendering PDFs on Android
 * Android WebView doesn't support native PDF rendering, so we use pdf.js
 */
function generatePdfJsHtml(base64Data: string, isDark: boolean): string {
  const bgColor = isDark ? '#121215' : '#ffffff';
  const textColor = isDark ? '#f8f8f8' : '#121215';
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { 
      width: 100%; 
      height: 100%; 
      background: ${bgColor};
      overflow-x: hidden;
    }
    #container {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 8px;
      gap: 8px;
    }
    canvas {
      max-width: 100%;
      height: auto;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      background: white;
    }
    #loading, #error {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      color: ${textColor};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
    }
    #error { color: #ef4444; display: none; }
    .page-num {
      color: ${isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)'};
      font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin-top: 4px;
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  <div id="loading">Loading PDF...</div>
  <div id="error">Failed to load PDF</div>
  <div id="container"></div>
  <script>
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    
    async function renderPDF() {
      try {
        const base64 = '${base64Data}';
        const binaryData = atob(base64);
        const bytes = new Uint8Array(binaryData.length);
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i);
        }
        
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        document.getElementById('loading').style.display = 'none';
        
        const container = document.getElementById('container');
        const containerWidth = window.innerWidth - 16;
        
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          const page = await pdf.getPage(pageNum);
          const viewport = page.getViewport({ scale: 1 });
          const scale = Math.min(containerWidth / viewport.width, 2.5);
          const scaledViewport = page.getViewport({ scale });
          
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          canvas.width = scaledViewport.width;
          canvas.height = scaledViewport.height;
          
          await page.render({ canvasContext: context, viewport: scaledViewport }).promise;
          container.appendChild(canvas);
          
          const pageLabel = document.createElement('div');
          pageLabel.className = 'page-num';
          pageLabel.textContent = 'Page ' + pageNum + ' of ' + pdf.numPages;
          container.appendChild(pageLabel);
        }
      } catch (err) {
        console.error('PDF render error:', err);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'block';
      }
    }
    
    renderPDF();
  </script>
</body>
</html>`;
}

/**
 * PDF Preview Component using WebView
 * - iOS: Uses native WebView PDF support with file:// URLs
 * - Android: Uses pdf.js for rendering since Android WebView lacks native PDF support
 */
function PdfPreview({ blobUrl, fileName }: { blobUrl?: string; fileName: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [pdfFileUri, setPdfFileUri] = useState<string | null>(null);
  const [pdfHtml, setPdfHtml] = useState<string | null>(null);
  
  const isAndroid = Platform.OS === 'android';

  // Process the PDF data based on platform
  useEffect(() => {
    if (!blobUrl) return;

    const processPdf = async () => {
      try {
        setIsLoading(true);
        setHasError(false);

        // Extract base64 data from data URL
        const base64Match = blobUrl.match(/^data:[^;]+;base64,(.+)$/);
        if (!base64Match) {
          log.error('Invalid PDF data URL format');
          setHasError(true);
          setIsLoading(false);
          return;
        }

        const base64Data = base64Match[1];

        if (isAndroid) {
          // Android: Generate HTML with pdf.js
          const html = generatePdfJsHtml(base64Data, isDark);
          setPdfHtml(html);
          setIsLoading(false);
        } else {
          // iOS: Write to temp file for native WebView rendering
          const tempFilePath = `${FileSystem.cacheDirectory}temp_${Date.now()}_${fileName}`;
          await FileSystem.writeAsStringAsync(tempFilePath, base64Data, {
            encoding: FileSystem.EncodingType.Base64,
          });
          setPdfFileUri(tempFilePath);
          setIsLoading(false);
        }
      } catch (error) {
        log.error('Failed to process PDF:', error);
        setHasError(true);
        setIsLoading(false);
      }
    };

    processPdf();

    // Cleanup temp file on unmount (iOS only)
    return () => {
      if (pdfFileUri) {
        FileSystem.deleteAsync(pdfFileUri, { idempotent: true }).catch(() => {});
      }
    };
  }, [blobUrl, fileName, isAndroid, isDark]);

  if (!blobUrl) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <KortixLoader size="large" />
        <Text className="text-sm text-muted-foreground mt-4">
          Loading PDF...
        </Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center" style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}>
        <KortixLoader size="large" />
        <Text className="text-sm text-muted-foreground mt-4">
          Preparing PDF...
        </Text>
      </View>
    );
  }

  if (hasError || (!pdfFileUri && !pdfHtml)) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <Icon
          as={AlertCircle}
          size={48}
          className="text-destructive mb-4"
          strokeWidth={1.5}
        />
        <Text className="text-sm text-muted-foreground text-center mb-2">
          Failed to load PDF
        </Text>
        <Text className="text-xs text-muted-foreground text-center">
          Try downloading the file instead
        </Text>
      </View>
    );
  }

  // Android: Use pdf.js HTML
  if (isAndroid && pdfHtml) {
    return (
      <View className="flex-1" style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}>
        <WebView
          source={{ html: pdfHtml }}
          style={{ flex: 1, backgroundColor: 'transparent' }}
          originWhitelist={['*']}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          mixedContentMode="compatibility"
          allowFileAccess={true}
          startInLoadingState={true}
          renderLoading={() => (
            <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}>
              <KortixLoader size="large" />
              <Text className="text-sm text-muted-foreground mt-4">
                Rendering PDF...
              </Text>
            </View>
          )}
          onError={(e) => {
            log.error('WebView PDF error (Android):', e.nativeEvent);
            setHasError(true);
          }}
        />
      </View>
    );
  }

  // iOS: Use native file:// URL rendering
  return (
    <View className="flex-1" style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}>
      <WebView
        source={{ uri: pdfFileUri! }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        originWhitelist={['*']}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowFileAccess={true}
        allowFileAccessFromFileURLs={true}
        allowUniversalAccessFromFileURLs={true}
        startInLoadingState={true}
        renderLoading={() => (
          <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}>
            <KortixLoader size="large" />
            <Text className="text-sm text-muted-foreground mt-4">
              Rendering PDF...
            </Text>
          </View>
        )}
        onError={(e) => {
          log.error('WebView PDF error (iOS):', e.nativeEvent);
          setHasError(true);
        }}
        onHttpError={(e) => {
          log.error('WebView PDF HTTP error:', e.nativeEvent);
          setHasError(true);
        }}
      />
    </View>
  );
}

/**
 * Generates HTML with embedded mammoth.js for rendering DOCX files
 * mammoth.js works reliably in WebView and converts DOCX to clean HTML
 */
function generateDocxHtml(base64Data: string, isDark: boolean): string {
  const bgColor = isDark ? '#121215' : '#ffffff';
  const textColor = isDark ? '#f8f8f8' : '#121215';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      min-height: 100%;
      background: ${bgColor};
      color: ${textColor};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 15px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    #loading {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      font-size: 14px;
    }
    #error {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      color: #ef4444;
      display: none;
      padding: 20px;
    }
    #container {
      padding: 20px;
      max-width: 100%;
    }
    /* Document styling to match Word appearance */
    #container h1 {
      font-size: 2em;
      font-weight: bold;
      margin: 0.67em 0;
      color: ${textColor};
    }
    #container h2 {
      font-size: 1.5em;
      font-weight: bold;
      margin: 0.83em 0;
      color: ${textColor};
    }
    #container h3 {
      font-size: 1.17em;
      font-weight: bold;
      margin: 1em 0;
      color: ${textColor};
    }
    #container h4 {
      font-size: 1em;
      font-weight: bold;
      margin: 1.33em 0;
      color: ${textColor};
    }
    #container p {
      margin: 1em 0;
    }
    #container ul, #container ol {
      margin: 1em 0;
      padding-left: 2em;
    }
    #container li {
      margin: 0.5em 0;
    }
    #container table {
      border-collapse: collapse;
      margin: 1em 0;
      width: 100%;
      font-size: 14px;
    }
    #container th, #container td {
      border: 1px solid ${isDark ? 'rgba(248,248,248,0.3)' : '#d1d5db'};
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
    }
    #container th {
      background: ${isDark ? 'rgba(248,248,248,0.1)' : '#f3f4f6'};
      font-weight: 600;
    }
    #container tr:nth-child(even) {
      background: ${isDark ? 'rgba(248,248,248,0.03)' : '#f9fafb'};
    }
    #container img {
      max-width: 100%;
      height: auto;
      margin: 1em 0;
    }
    #container a {
      color: ${isDark ? '#60a5fa' : '#2563eb'};
      text-decoration: underline;
    }
    #container blockquote {
      border-left: 4px solid ${isDark ? 'rgba(248,248,248,0.3)' : '#d1d5db'};
      padding-left: 1em;
      margin: 1em 0;
      color: ${isDark ? 'rgba(248,248,248,0.7)' : '#6b7280'};
      font-style: italic;
    }
    #container strong, #container b {
      font-weight: 600;
    }
    #container em, #container i {
      font-style: italic;
    }
    #container u {
      text-decoration: underline;
    }
    #container code {
      background: ${isDark ? 'rgba(248,248,248,0.1)' : '#f3f4f6'};
      padding: 2px 6px;
      border-radius: 4px;
      font-family: ui-monospace, monospace;
      font-size: 0.9em;
    }
    #container pre {
      background: ${isDark ? 'rgba(248,248,248,0.1)' : '#f3f4f6'};
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1em 0;
    }
    #container hr {
      border: none;
      border-top: 1px solid ${isDark ? 'rgba(248,248,248,0.2)' : '#e5e7eb'};
      margin: 2em 0;
    }
  </style>
</head>
<body>
  <div id="loading">Loading document...</div>
  <div id="error">Failed to load document</div>
  <div id="container"></div>
  <script>
    async function renderDocx() {
      try {
        const base64 = '${base64Data}';
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        const result = await mammoth.convertToHtml(
          { arrayBuffer: bytes.buffer },
          {
            styleMap: [
              "p[style-name='Heading 1'] => h1:fresh",
              "p[style-name='Heading 2'] => h2:fresh",
              "p[style-name='Heading 3'] => h3:fresh",
              "p[style-name='Heading 4'] => h4:fresh",
              "r[style-name='Strong'] => strong",
              "r[style-name='Emphasis'] => em",
            ]
          }
        );

        document.getElementById('loading').style.display = 'none';
        document.getElementById('container').innerHTML = result.value;

        if (result.messages && result.messages.length > 0) {
          console.log('Mammoth messages:', result.messages);
        }
      } catch (err) {
        console.error('DOCX render error:', err);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'block';
        document.getElementById('error').textContent = 'Failed to load document: ' + (err.message || err);
      }
    }

    // Wait for mammoth to load
    if (typeof mammoth !== 'undefined') {
      renderDocx();
    } else {
      document.getElementById('loading').textContent = 'Loading library...';
      window.onload = function() {
        if (typeof mammoth !== 'undefined') {
          renderDocx();
        } else {
          document.getElementById('loading').style.display = 'none';
          document.getElementById('error').style.display = 'block';
          document.getElementById('error').textContent = 'Failed to load document library';
        }
      };
    }
  </script>
</body>
</html>`;
}

/**
 * DOCX Preview Component using WebView and mammoth.js
 * Converts DOCX to HTML for rendering
 */
function DocxPreview({ blobUrl, fileName }: { blobUrl?: string; fileName: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!blobUrl) return;

    const processDocx = async () => {
      try {
        setIsLoading(true);
        setHasError(false);

        // Extract base64 data from data URL
        const base64Match = blobUrl.match(/^data:[^;]+;base64,(.+)$/);
        if (!base64Match) {
          log.error('[DocxPreview] Invalid data URL format');
          setHasError(true);
          setIsLoading(false);
          return;
        }

        const base64Data = base64Match[1];
        const html = generateDocxHtml(base64Data, isDark);
        setDocxHtml(html);
        setIsLoading(false);
      } catch (error) {
        log.error('[DocxPreview] Failed to process DOCX:', error);
        setHasError(true);
        setIsLoading(false);
      }
    };

    processDocx();
  }, [blobUrl, isDark]);

  if (!blobUrl) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <KortixLoader size="large" />
        <Text className="text-sm text-muted-foreground mt-4">
          Loading document...
        </Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center" style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}>
        <KortixLoader size="large" />
        <Text className="text-sm text-muted-foreground mt-4">
          Preparing document...
        </Text>
      </View>
    );
  }

  if (hasError || !docxHtml) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <Icon
          as={AlertCircle}
          size={48}
          className="text-destructive mb-4"
          strokeWidth={1.5}
        />
        <Text className="text-sm text-muted-foreground text-center mb-2">
          Failed to load document
        </Text>
        <Text className="text-xs text-muted-foreground text-center">
          Try downloading the file instead
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1" style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}>
      <WebView
        source={{ html: docxHtml }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        originWhitelist={['*']}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        mixedContentMode="compatibility"
        startInLoadingState={true}
        renderLoading={() => (
          <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}>
            <KortixLoader size="large" />
            <Text className="text-sm text-muted-foreground mt-4">
              Rendering document...
            </Text>
          </View>
        )}
        onError={(e) => {
          log.error('[DocxPreview] WebView error:', e.nativeEvent);
          setHasError(true);
        }}
      />
    </View>
  );
}

/**
 * Fallback Preview Component
 */
function FallbackPreview({ fileName, previewType }: { fileName: string; previewType: FilePreviewType }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  let message = 'Preview not available';
  if (previewType === FilePreviewType.XLSX) {
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

  // For PDFs, we need the blob URL
  if (previewType === FilePreviewType.PDF) {
    return <PdfPreview blobUrl={blobUrl} fileName={fileName} />;
  }

  // For DOCX, we need the blob URL
  if (previewType === FilePreviewType.DOCX) {
    return <DocxPreview blobUrl={blobUrl} fileName={fileName} />;
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

    case FilePreviewType.XLSX:
    case FilePreviewType.BINARY:
      return <FallbackPreview fileName={fileName} previewType={previewType} />;

    case FilePreviewType.OTHER:
    default:
      // Any unrecognized file with text content — render as plain text
      return <TextPreview content={content} />;
  }
}

