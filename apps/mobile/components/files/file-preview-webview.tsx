/**
 * The WebView half of the file preview renderers: the shared `PreviewWebView`
 * wrapper, its navigation guard, the sandbox HTML preview URL builder, the
 * bottom-inset context every renderer ends its content above, and the shared
 * `PreviewStatus` (the centered loader / preparing / error screens). The blob
 * document renderers live in `./file-preview-documents`; the text renderers
 * and the `FilePreview` dispatch in `./FilePreviewRenderers`.
 */

import React, { useCallback } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
} from 'react-native-webview/lib/WebViewTypes';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { log } from '@/lib/logger';
import {
  decidePreviewNavigation,
  type PreviewNavigationOptions,
} from '@/lib/utils/html-embed';
import { openLink } from '@/lib/utils/open-link';

/**
 * Constructs a preview URL for HTML files in the sandbox environment.
 * Properly handles URL encoding of file paths by encoding each path segment individually.
 */
export function constructHtmlPreviewUrl(
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

/**
 * Space the host keeps clear at the bottom of a preview, for controls that float
 * over it (the session file sheet's pinned bar, the project drawer's approach).
 * Each renderer ends its content that far above the edge, so the last line of a
 * document rests above the controls. 0 (the default) changes nothing.
 */
export const FilePreviewBottomInsetContext = React.createContext(0);

/**
 * onShouldStartLoadWithRequest handler for preview WebViews. Inline loads stay
 * in the WebView, web and mail links open outside the app, and every other
 * navigation is blocked.
 */
export function usePreviewNavigationGuard({
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
 * The preview WebView, minus the properties every preview sets identically.
 * Callers keep only their own source, guard and loading/error UI.
 */
export function PreviewWebView({
  source,
  onShouldStartLoadWithRequest,
  scrollEnabled,
  showsVerticalScrollIndicator,
  scalesPageToFit,
  bounces,
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
  /** Scroll props pass straight through; `undefined` keeps the WebView default. */
  scrollEnabled?: boolean;
  showsVerticalScrollIndicator?: boolean;
  scalesPageToFit?: boolean;
  bounces?: boolean;
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
      scrollEnabled={scrollEnabled}
      showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      scalesPageToFit={scalesPageToFit}
      bounces={bounces}
      startInLoadingState
      renderLoading={() => loading}
      onError={onError}
      onHttpError={onHttpError}
    />
  );
}

/**
 * One centered preview status screen: a loader (or an `icon` instead), a
 * title, and an optional detail line under it. `className` carries the
 * container (fill vs overlay); `style` its background.
 */
export function PreviewStatus({
  className,
  style,
  icon,
  title,
  detail,
}: {
  className: string;
  style?: StyleProp<ViewStyle>;
  /** Replaces the loader (the error screens' alert icon). */
  icon?: React.ReactNode;
  title: string;
  detail?: string;
}) {
  return (
    <View className={className} style={style}>
      {icon ?? <KortixLoader size="small" />}
      <Text className={icon ? 'text-sm text-muted-foreground text-center mb-2' : 'text-sm text-muted-foreground mt-4 text-center'}>
        {title}
      </Text>
      {detail ? <Text className="text-xs text-muted-foreground text-center">{detail}</Text> : null}
    </View>
  );
}
