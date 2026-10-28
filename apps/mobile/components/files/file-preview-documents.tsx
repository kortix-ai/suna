/**
 * The blob renderers of the file preview: image, PDF (native on iOS, pdf.js on
 * Android) and DOCX (mammoth.js -> HTML). The shared WebView plumbing they all
 * render through lives in `./file-preview-webview`; the text renderers and the
 * `FilePreview` dispatch in `./FilePreviewRenderers`.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useColorScheme } from 'nativewind';
import { View, Image, ScrollView, Platform, useWindowDimensions } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { WarningCircleIcon as AlertCircle } from '@/lib/icons';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { log } from '@/lib/logger';
import type { SharedImageSource } from '@/lib/files/shared-image';
import { generatePdfJsHtml, generateDocxHtml } from './file-preview-html';
import {
  FilePreviewBottomInsetContext,
  PreviewStatus,
  PreviewWebView,
  usePreviewNavigationGuard,
} from './file-preview-webview';

export function ImagePreview({
  blobUrl,
  source,
  initialRatio,
  onSourceError,
  fileName,
}: {
  blobUrl?: string;
  /** An image already loaded elsewhere (R38): drawn from its native source, at its known ratio, with no loader. */
  source?: SharedImageSource;
  initialRatio?: number | null;
  /** `source` failed to draw: the caller reads the file instead. */
  onSourceError?: () => void;
  fileName: string;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [isLoading, setIsLoading] = useState(!(source && initialRatio));
  const [hasError, setHasError] = useState(false);
  // Width/height ratio of the loaded image; the box follows the live window width.
  const [aspectRatio, setAspectRatio] = useState(source && initialRatio ? initialRatio : 0);
  const { width: screenWidth } = useWindowDimensions();
  const maxWidth = screenWidth - 32;
  const bottomInset = React.useContext(FilePreviewBottomInsetContext);

  const imageSource = source ?? (blobUrl ? { uri: blobUrl } : undefined);
  if (!imageSource) {
    return (
      <PreviewStatus className="flex-1 items-center justify-center p-8" title="Loading image..." />
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
        <PreviewStatus
          className="items-center justify-center p-8"
          icon={<Icon as={AlertCircle} size={48} className="text-destructive mb-4" />}
          title="Failed to load image"
        />
      ) : (
        <View className="items-center">
          {isLoading && (
            <View className="absolute inset-0 items-center justify-center z-10">
              <KortixLoader size="small" />
            </View>
          )}
          <Image
            source={imageSource}
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
              if (source && onSourceError) return onSourceError();
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
 * PDF Preview Component using WebView
 * - iOS: Uses native WebView PDF support with file:// URLs
 * - Android: Uses pdf.js for rendering since Android WebView lacks native PDF support
 */
export function PdfPreview({ blobUrl, fileName }: { blobUrl?: string; fileName: string }) {
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
      <PreviewStatus className="flex-1 items-center justify-center p-8" title="Loading PDF..." />
    );
  }

  if (isLoading) {
    return (
      <PreviewStatus
        className="flex-1 items-center justify-center"
        style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}
        title="Preparing PDF..."
      />
    );
  }

  if (hasError || (!pdfFileUri && !pdfHtml)) {
    return (
      <PreviewStatus
        className="flex-1 items-center justify-center p-8"
        icon={<Icon as={AlertCircle} size={48} className="text-destructive mb-4" />}
        title="Failed to load PDF"
        detail="Try downloading the file instead"
      />
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
          loading={
            <PreviewStatus
              className="absolute inset-0 items-center justify-center"
              style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}
              title="Rendering PDF..."
            />}
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
        loading={
            <PreviewStatus
              className="absolute inset-0 items-center justify-center"
              style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}
              title="Rendering PDF..."
            />}
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
export function DocxPreview({ blobUrl, fileName }: { blobUrl?: string; fileName: string }) {
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
      <PreviewStatus className="flex-1 items-center justify-center p-8" title="Loading document..." />
    );
  }

  if (isLoading) {
    return (
      <PreviewStatus
        className="flex-1 items-center justify-center"
        style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}
        title="Preparing document..."
      />
    );
  }

  if (hasError || !docxHtml) {
    return (
      <PreviewStatus
        className="flex-1 items-center justify-center p-8"
        icon={<Icon as={AlertCircle} size={48} className="text-destructive mb-4" />}
        title="Failed to load document"
        detail="Try downloading the file instead"
      />
    );
  }

  return (
    <View className="flex-1" style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}>
      <PreviewWebView
        source={{ html: docxHtml }}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        mixedContentMode="compatibility"
        domStorageEnabled
        loading={
          <PreviewStatus
            className="absolute inset-0 items-center justify-center"
            style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}
            title="Rendering document..."
          />}
        onError={(e) => {
          log.error('[DocxPreview] WebView error:', e.nativeEvent);
          setHasError(true);
        }}
      />
    </View>
  );
}
