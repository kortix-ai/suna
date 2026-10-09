/**
 * File Preview Renderers
 * Components for previewing different file types
 */

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { View, Image, ScrollView, Platform, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
} from 'react-native-webview/lib/WebViewTypes';
import { MermaidBlock } from '@/components/markdown/mermaid/MermaidBlock';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { WarningCircleIcon as AlertCircle, FileTextIcon as FileText } from '@/lib/icons';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SelectableMarkdownText } from '@/components/kortix/selectable-markdown';
import { autoLinkUrls } from '@kortix/shared';
import * as FileSystem from 'expo-file-system/legacy';
import { log } from '@/lib/logger';
import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import { THEME, withAlpha } from '@/lib/utils/theme';
import {
  decidePreviewNavigation,
  type PreviewNavigationOptions,
} from '@/lib/utils/html-embed';
import {
  CSV_MAX_COLUMNS,
  JSON_PRETTY_PRINT_MAX_CHARS,
  TEXT_TRUNCATE_DISPLAY_BYTES,
  previewDecision,
  truncateForPreview,
} from '@/lib/files/preview-limits';
import { generateHighlightedCodeHtml, generatePdfJsHtml, generateDocxHtml } from './file-preview-html';
import {
  FilePreviewType,
  getFilePreviewType,
  getLanguageFromFilename,
} from '@/lib/files/preview-type';
import { openLink } from '@/lib/utils/open-link';

// Classification moved to `@/lib/files/preview-type`; callers import it from
// here (`./FilePreviewRenderers`) as before.
export { FilePreviewType, getFilePreviewType, getLanguageFromFilename } from '@/lib/files/preview-type';

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

/**
 * Space the host keeps clear at the bottom of a preview, for controls that float
 * over it (the session file sheet's pinned bar, the project drawer's approach).
 * Each renderer ends its content that far above the edge, so the last line of a
 * document rests above the controls. 0 (the default) changes nothing.
 */
export const FilePreviewBottomInsetContext = React.createContext(0);

interface FilePreviewProps {
  content: string | Blob | null;
  fileName: string;
  previewType: FilePreviewType;
  blobUrl?: string;
  filePath?: string;
  sandboxUrl?: string;
  /** File size in bytes, when known. Files over the preview limits are not rendered. */
  size?: number;
}

/**
 * onShouldStartLoadWithRequest handler for preview WebViews. Inline loads stay
 * in the WebView, web and mail links open outside the app, and every other
 * navigation is blocked.
 */
function usePreviewNavigationGuard({
  allowedOrigin,
  allowFileUrls,
  externalRequiresClick,
}: Omit<PreviewNavigationOptions, 'isTopFrame' | 'navigationType'> = {}) {
  return useCallback(
    (request: ShouldStartLoadRequest) => {
      const action = decidePreviewNavigation(request.url, {
        allowedOrigin,
        allowFileUrls,
        externalRequiresClick,
        isTopFrame: request.isTopFrame,
        navigationType: request.navigationType,
      });
      if (action === 'open-external') {
        openLink(request.url).catch((error) => {
          log.warn('[FilePreview] Failed to open link:', error);
        });
      }
      return action === 'allow';
    },
    [allowedOrigin, allowFileUrls, externalRequiresClick],
  );
}

/**
 * Image Preview Component
 */

/**
 * The preview WebView, minus the properties every preview sets identically.
 * Callers keep only their own source, guard and loading/error UI.
 */
function PreviewWebView({
  source,
  onShouldStartLoadWithRequest,
  scroll = false,
  allowFileAccess,
  mixedContentMode,
  domStorageEnabled,
  style,
  contentInset,
  loading,
  onError,
  onHttpError,
}: {
  source: { uri: string } | { html: string };
  onShouldStartLoadWithRequest: (request: ShouldStartLoadRequest) => boolean;
  /** Code previews scroll; the pdf.js / mammoth hosts manage their own scroll. */
  scroll?: boolean;
  allowFileAccess?: boolean;
  mixedContentMode?: 'compatibility';
  domStorageEnabled?: boolean;
  /** The HTML preview uses an opaque page background and an iOS-only inset. */
  style?: StyleProp<ViewStyle>;
  contentInset?: { top?: number; bottom?: number; left?: number; right?: number };
  loading: React.ReactElement;
  onError?: (event: WebViewErrorEvent) => void;
  onHttpError?: (event: WebViewHttpErrorEvent) => void;
}) {
  return (
    <WebView
      source={source}
      style={[{ flex: 1, backgroundColor: 'transparent' }, style]}
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      javaScriptEnabled
      domStorageEnabled={domStorageEnabled}
      allowFileAccess={allowFileAccess}
      mixedContentMode={mixedContentMode}
      contentInset={contentInset}
      scrollEnabled={scroll}
      showsVerticalScrollIndicator={scroll}
      scalesPageToFit={!scroll}
      bounces={!scroll}
      startInLoadingState
      renderLoading={() => loading}
      onError={onError}
      onHttpError={onHttpError}
    />
  );
}

function ImagePreview({ blobUrl, fileName }: { blobUrl?: string; fileName: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  // Width/height ratio of the loaded image; the box follows the live window width.
  const [aspectRatio, setAspectRatio] = useState(0);
  const { width: screenWidth } = useWindowDimensions();
  const maxWidth = screenWidth - 32;
  const bottomInset = React.useContext(FilePreviewBottomInsetContext);

  if (!blobUrl) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <KortixLoader size="small" />
        <Text className="text-sm text-muted-foreground mt-4">
          Loading image...
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ padding: 16, paddingBottom: 16 + bottomInset }}
      showsVerticalScrollIndicator={false}
      style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}
    >
      {hasError ? (
        <View className="items-center justify-center p-8">
          <Icon
            as={AlertCircle}
            size={48}
            className="text-destructive mb-4"
          />
          <Text className="text-sm text-muted-foreground text-center">
            Failed to load image
          </Text>
        </View>
      ) : (
        <View className="items-center">
          {isLoading && (
            <View className="absolute inset-0 items-center justify-center z-10">
              <KortixLoader size="small" />
            </View>
          )}
          <Image
            source={{ uri: blobUrl }}
            style={{
              width: maxWidth,
              height: aspectRatio ? maxWidth / aspectRatio : 300,
            }}
            resizeMode="contain"
            onLoad={(event) => {
              const { width, height } = event.nativeEvent.source;
              setAspectRatio(width / height);
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
  const bottomInset = React.useContext(FilePreviewBottomInsetContext);

  return (
    <ScrollView
      className="flex-1 px-4 py-4"
      showsVerticalScrollIndicator={true}
      contentContainerStyle={{ paddingBottom: bottomInset }}
      style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}
    >
      <SelectableMarkdownText isDark={isDark} remoteImages="load">
        {autoLinkUrls(content)}
      </SelectableMarkdownText>
    </ScrollView>
  );
}



/**
 * Code Preview Component with syntax highlighting via highlight.js WebView.
 */
function CodePreview({ content, fileName }: { content: string; fileName: string }) {
  const bottomInset = React.useContext(FilePreviewBottomInsetContext);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const language = getLanguageFromFilename(fileName);
  const onShouldStartLoadWithRequest = usePreviewNavigationGuard();

  const html = useMemo(
    () => generateHighlightedCodeHtml(content, language, isDark, bottomInset),
    [content, language, isDark, bottomInset],
  );

  return (
    <View className="flex-1" style={{ backgroundColor: isDark ? THEME.dark.card : THEME.light.card }}>
      {/* Highlighted code */}
      <PreviewWebView
        source={{ html }}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        scroll
        loading={
          <View
            className="absolute inset-0 items-center justify-center"
            style={{ backgroundColor: isDark ? THEME.dark.card : THEME.light.card }}
          >
            <KortixLoader size="small" />
          </View>
        }
      />
      {/* Language badge at bottom. Hidden under a host's floating controls. */}
      {bottomInset === 0 ? (
        <View
          className="px-4 pt-2 border-t"
          style={{
            borderTopColor: isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.06),
            backgroundColor: isDark ? THEME.dark.background : THEME.light.background,
            paddingBottom: Math.max(insets.bottom, 8),
          }}
        >
          <Text
            className="text-xs font-roobert-medium"
            style={{
              color: isDark ? withAlpha(THEME.dark.foreground, 0.4) : withAlpha(THEME.light.foreground, 0.4),
            }}
          >
            {language.toUpperCase()}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
/**
 * HTML Preview Component with Daytona iframe
 */
/**
 * JSON: pretty-printed below the pretty-print size limit, raw at or above it.
 * Otherwise the code preview: highlight.js with the `json` language and the
 * same language badge.
 */
function JsonPreview({ content, fileName }: { content: string; fileName: string }) {
  const formattedJson = useMemo(() => {
    if (content.length >= JSON_PRETTY_PRINT_MAX_CHARS) return content;
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return content;
    }
  }, [content]);
  return <CodePreview content={formattedJson} fileName={fileName} />;
}

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

  const bottomInset = React.useContext(FilePreviewBottomInsetContext);
  // If we have sandbox URL and file path, use Daytona iframe to preview
  const htmlPreviewUrl = constructHtmlPreviewUrl(sandboxUrl, filePath);
  // Pages of the previewed site stay in the WebView. Another site opens outside
  // the app only for a user click, so a script redirect or an iframe in the
  // page cannot launch the browser. Tradeoff: only iOS reports clicks
  // (navigationType 'click'). Android sends no click or frame information, so
  // on Android a tap on an external link in an HTML preview does nothing.
  const onShouldStartLoadWithRequest = usePreviewNavigationGuard({
    allowedOrigin: htmlPreviewUrl,
    externalRequiresClick: true,
  });

  if (htmlPreviewUrl) {
    return (
      // Android has no `contentInset`: the WebView ends above the host's
      // floating controls instead, so the page's end is never under them.
      <View className="flex-1" style={Platform.OS === 'android' ? { paddingBottom: bottomInset } : undefined}>
        <PreviewWebView
          source={{ uri: htmlPreviewUrl }}
          // iOS only: the page's end rests above a host's floating controls.
          contentInset={{ bottom: bottomInset }}
          domStorageEnabled
          style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          loading={
            <View className="flex-1 items-center justify-center">
              <KortixLoader size="small" />
              <Text
                className="text-sm mt-4 font-roobert"
                style={{ color: isDark ? withAlpha(THEME.dark.foreground, 0.5) : withAlpha(THEME.light.foreground, 0.5) }}
              >
                Loading preview...
              </Text>
            </View>
          }
        />
      </View>
    );
  }

  // Fallback: Show as text if no sandbox URL available
  return <TextPreview content={content} />;
}

/**
 * Text Preview Component. Also the "Pasted text" sheet's body (`PastedTextSheet`).
 */
export function TextPreview({ content }: { content: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const bottomInset = React.useContext(FilePreviewBottomInsetContext);

  return (
    <ScrollView
      className="flex-1 px-4 py-4"
      showsVerticalScrollIndicator={true}
      contentContainerStyle={{ paddingBottom: bottomInset }}
      style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}
    >
      <Text
        style={{
          color: isDark ? THEME.dark.foreground : THEME.light.foreground,
          fontFamily: MONO_FONT_FAMILY,
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
  const bottomInset = React.useContext(FilePreviewBottomInsetContext);

  // Parse CSV content
  const rows = content.split('\n').filter(row => row.trim());
  const headers = rows[0]?.split(',').slice(0, CSV_MAX_COLUMNS).map(h => h.trim()) || [];
  const dataRows = rows.slice(1);

  // Vertical outside, horizontal inside: on Android the outer scroll view sees
  // a drag first, and a horizontal one takes any drag that drifts sideways.
  return (
    <ScrollView
      showsVerticalScrollIndicator={true}
      className="flex-1"
      contentContainerStyle={{ paddingBottom: bottomInset }}
      style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={true}>
        <View className="px-4 py-4">
        {/* Headers */}
        <View className="flex-row border-b pb-2 mb-2"
          style={{
            borderBottomColor: isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.1),
          }}
        >
          {headers.map((header, index) => (
            <View
              key={index}
              style={{ width: 120, marginRight: 12 }}
            >
              <Text
                style={{ color: isDark ? THEME.dark.foreground : THEME.light.foreground }}
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
          const cells = row.split(',').slice(0, CSV_MAX_COLUMNS).map(c => c.trim());
          return (
            <View
              key={rowIndex}
              className="flex-row py-2 border-b"
              style={{
                borderBottomColor: isDark ? withAlpha(THEME.dark.foreground, 0.05) : withAlpha(THEME.light.foreground, 0.05),
              }}
            >
              {cells.map((cell, cellIndex) => (
                <View
                  key={cellIndex}
                  style={{ width: 120, marginRight: 12 }}
                >
                  <Text
                    style={{ color: isDark ? withAlpha(THEME.dark.foreground, 0.8) : withAlpha(THEME.light.foreground, 0.8) }}
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
        </View>
      </ScrollView>
    </ScrollView>
  );
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
  // The cleanup closure must read the latest temp file, not the value captured
  // when the effect ran.
  const pdfFileUriRef = useRef<string | null>(null);
  
  const isAndroid = Platform.OS === 'android';
  const onShouldStartLoadWithRequest = usePreviewNavigationGuard({ allowFileUrls: !isAndroid });

  // Process the PDF data based on platform
  useEffect(() => {
    if (!blobUrl) return;
    let cancelled = false;

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
          if (cancelled) {
            FileSystem.deleteAsync(tempFilePath, { idempotent: true }).catch(() => {});
            return;
          }
          pdfFileUriRef.current = tempFilePath;
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

    // Delete the temp file when the PDF changes or the preview unmounts (iOS only)
    return () => {
      cancelled = true;
      const tempFile = pdfFileUriRef.current;
      pdfFileUriRef.current = null;
      if (tempFile) {
        FileSystem.deleteAsync(tempFile, { idempotent: true }).catch(() => {});
      }
    };
  }, [blobUrl, fileName, isAndroid, isDark]);

  if (!blobUrl) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <KortixLoader size="small" />
        <Text className="text-sm text-muted-foreground mt-4">
          Loading PDF...
        </Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center" style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}>
        <KortixLoader size="small" />
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
      <View className="flex-1" style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}>
        <PreviewWebView
          source={{ html: pdfHtml }}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          allowFileAccess
          mixedContentMode="compatibility"
          domStorageEnabled
          loading={            <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}>
              <KortixLoader size="small" />
              <Text className="text-sm text-muted-foreground mt-4">
                Rendering PDF...
              </Text>
            </View>}
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
    <View className="flex-1" style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}>
      <PreviewWebView
        source={{ uri: pdfFileUri! }}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        allowFileAccess
        domStorageEnabled
        loading={            <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}>
              <KortixLoader size="small" />
              <Text className="text-sm text-muted-foreground mt-4">
                Rendering PDF...
              </Text>
            </View>}
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
 * DOCX Preview Component using WebView and mammoth.js
 * Converts DOCX to HTML for rendering
 */
function DocxPreview({ blobUrl, fileName }: { blobUrl?: string; fileName: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const onShouldStartLoadWithRequest = usePreviewNavigationGuard();

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
        <KortixLoader size="small" />
        <Text className="text-sm text-muted-foreground mt-4">
          Loading document...
        </Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center" style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}>
        <KortixLoader size="small" />
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
    <View className="flex-1" style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}>
      <PreviewWebView
        source={{ html: docxHtml }}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        mixedContentMode="compatibility"
        domStorageEnabled
        loading={          <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}>
            <KortixLoader size="small" />
            <Text className="text-sm text-muted-foreground mt-4">
              Rendering document...
            </Text>
          </View>}
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
function FallbackPreview({
  fileName,
  previewType,
  tooLarge = false,
}: {
  fileName: string;
  previewType: FilePreviewType;
  tooLarge?: boolean;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  let message = 'Preview not available';
  if (tooLarge) {
    message = 'This file is too large to preview. Download it instead.';
  } else if (previewType === FilePreviewType.XLSX) {
    message = 'Spreadsheet preview requires download';
  }

  return (
    <View className="flex-1 items-center justify-center p-8">
      <Icon
        as={FileText}
        size={48}
        color={isDark ? withAlpha(THEME.dark.foreground, 0.3) : withAlpha(THEME.light.foreground, 0.3)}
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
 * Notice above a text preview that shows only the start of the file.
 */
function TruncationNotice() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <View
      className="px-4 py-2"
      style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}
    >
      <Text variant="muted" className="text-center">
        Showing the first {Math.round(TEXT_TRUNCATE_DISPLAY_BYTES / 1024)} KB. Download the file to see all of it.
      </Text>
    </View>
  );
}

function TextContentPreview({
  content,
  fileName,
  previewType,
  filePath,
  sandboxUrl,
}: {
  content: string;
  fileName: string;
  previewType: FilePreviewType;
  filePath?: string;
  sandboxUrl?: string;
}) {
  const { colorScheme } = useColorScheme();
  switch (previewType) {
    case FilePreviewType.MERMAID:
      return <MermaidBlock chart={content} language="mermaid" isDark={colorScheme === 'dark'} />;
    case FilePreviewType.MARKDOWN:
      return <MarkdownPreview content={content} />;

    case FilePreviewType.HTML:
      return <HtmlPreview content={content} filePath={filePath} sandboxUrl={sandboxUrl} />;

    case FilePreviewType.JSON:
      return <JsonPreview content={content} fileName={fileName} />;

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

/**
 * Main File Preview Component
 */
export function FilePreview({
  content,
  fileName,
  previewType,
  blobUrl,
  filePath,
  sandboxUrl,
  size,
}: FilePreviewProps) {
  // Size gate for text content. Memoized so a parent re-render does not hand
  // the renderers a new truncated string (which would rebuild WebView HTML).
  const textPreview = useMemo(() => {
    if (typeof content !== 'string' || !content) return null;
    const decision = previewDecision({ size: content.length, previewType });
    if (decision !== 'truncate') return { decision, text: content };
    return { decision, text: truncateForPreview(content).text };
  }, [content, previewType]);

  const sizeDecision = previewDecision({ size, previewType });

  // An HTML file with a sandbox URL loads the page by URL, not through JS, so
  // the size limits do not apply to it.
  const loadsFromSandbox =
    previewType === FilePreviewType.HTML && !!constructHtmlPreviewUrl(sandboxUrl, filePath);
  if (loadsFromSandbox && (textPreview || sizeDecision === 'too-large')) {
    return <HtmlPreview content={textPreview?.text ?? ''} filePath={filePath} sandboxUrl={sandboxUrl} />;
  }

  // Files known to exceed the limits are never rendered; Download stays available.
  if (sizeDecision === 'too-large') {
    return <FallbackPreview fileName={fileName} previewType={previewType} tooLarge />;
  }

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
  if (!textPreview) {
    return <FallbackPreview fileName={fileName} previewType={previewType} />;
  }

  if (textPreview.decision === 'too-large') {
    return <FallbackPreview fileName={fileName} previewType={previewType} tooLarge />;
  }

  const preview = (
    <TextContentPreview
      content={textPreview.text}
      fileName={fileName}
      previewType={previewType === FilePreviewType.MERMAID && textPreview.decision === 'truncate' ? FilePreviewType.TEXT : previewType}
      filePath={filePath}
      sandboxUrl={sandboxUrl}
    />
  );

  if (textPreview.decision === 'truncate') {
    return (
      <View className="flex-1">
        <TruncationNotice />
        {preview}
      </View>
    );
  }

  return preview;
}
