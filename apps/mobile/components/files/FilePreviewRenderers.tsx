/**
 * File Preview Renderers — the text half: markdown, code, JSON, HTML, text,
 * CSV previews, the fallback screens, and the `FilePreview` dispatch that
 * picks the renderer. The WebView plumbing and the shared `PreviewStatus`
 * live in `./file-preview-webview`; the blob document renderers (image, PDF,
 * DOCX) in `./file-preview-documents`.
 */

import React, { useMemo } from 'react';
import { View, ScrollView, Platform } from 'react-native';
import { MermaidBlock } from '@/components/markdown/mermaid/MermaidBlock';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { FileTextIcon as FileText } from '@/lib/icons';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SelectableMarkdownText } from '@/components/kortix/selectable-markdown';
import { autoLinkUrls } from '@kortix/shared';
import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { CSV_MAX_COLUMNS, JSON_PRETTY_PRINT_MAX_CHARS, TEXT_TRUNCATE_DISPLAY_BYTES, previewDecision, truncateForPreview } from '@/lib/files/preview-limits';
import { generateHighlightedCodeHtml } from './file-preview-html';
import { FilePreviewType, getLanguageFromFilename } from '@/lib/files/preview-type';
import type { SharedImageSource } from '@/lib/files/shared-image';
import {
  constructHtmlPreviewUrl,
  FilePreviewBottomInsetContext,
  PreviewStatus,
  PreviewWebView,
  usePreviewNavigationGuard,
} from './file-preview-webview';
import { ImagePreview, PdfPreview, DocxPreview } from './file-preview-documents';

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
        scrollEnabled
        showsVerticalScrollIndicator
        scalesPageToFit={false}
        bounces={false}
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
 * HTML Preview Component with a sandbox iframe
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
  // If we have sandbox URL and file path, use the sandbox iframe to preview
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

interface FilePreviewProps {
  content: string | Blob | null;
  fileName: string;
  previewType: FilePreviewType;
  blobUrl?: string;
  filePath?: string;
  sandboxUrl?: string;
  /** File size in bytes, when known. Files over the preview limits are not rendered. */
  size?: number;
  /** An image already loaded elsewhere (`useFilePreviewData`, R38): drawn at once, in place of `blobUrl`. */
  imageSource?: SharedImageSource;
  imageRatio?: number | null;
  onImageSourceError?: () => void;
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
  imageSource,
  imageRatio,
  onImageSourceError,
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
    return (
      <ImagePreview blobUrl={blobUrl} source={imageSource} initialRatio={imageRatio} onSourceError={onImageSourceError} fileName={fileName} />
    );
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

