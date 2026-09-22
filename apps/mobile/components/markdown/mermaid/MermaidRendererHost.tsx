/**
 * The one hidden WebView that turns Mermaid source into SVG.
 *
 * Every mounted diagram block renders `<MermaidRendererPortal />`. The first
 * of them owns the renderer and portals one `MermaidRendererHost` into the
 * app's root `PortalHost` (`app/_layout.tsx`), so the WebView sits outside
 * the chat list and never scrolls or recycles with a row. When the owner
 * unmounts, the next mounted block takes over; the WebView reloads, and the
 * queue re-sends any render that was still waiting. With no diagram block
 * mounted, the WebView is gone.
 *
 * The host renders nothing until a block asks `mermaidRenderQueue` for a
 * render, then loads Mermaid 11.15.0 from `assets/mermaid/mermaid.min.webjs`
 * (an Expo asset, not part of the Hermes bundle; read once per app session).
 *
 * When the OS kills the WebView process (iOS `onContentProcessDidTerminate`,
 * Android `onRenderProcessGone`), the host remounts it and the queue re-sends
 * every unanswered request.
 */
import { Portal } from '@rn-primitives/portal';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { log } from '@/lib/logger';

import { allowInlineDocumentLoad, rendererBootScript, rendererHtml } from './mermaid-html';
import { mermaidRenderQueue } from './mermaid-render-queue';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MERMAID_ASSET = require('@/assets/mermaid/mermaid.min.webjs');

let sourcePromise: Promise<string> | null = null;
let loadedSource: string | null = null;

/** Reads the Mermaid bundle once per app session; a failed read retries next time. */
function loadMermaidSource(): Promise<string> {
  sourcePromise ??= (async () => {
    const asset = Asset.fromModule(MERMAID_ASSET);
    await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    loadedSource = await new File(uri).text();
    return loadedSource;
  })().catch((error: unknown) => {
    sourcePromise = null;
    throw error;
  });
  return sourcePromise;
}

const RENDERER_SOURCE = { html: rendererHtml(), baseUrl: '' };
// Every URL reaches the guard, which allows only the inline document: without
// `['*']`, react-native-webview opens non-http(s) URLs outside the app first.
const ORIGIN_WHITELIST = ['*'];

const PORTAL_NAME = 'kortix-mermaid-renderer';

/** Mounted diagram blocks, oldest first; the first one owns the renderer portal. */
const owners: symbol[] = [];
const ownerListeners = new Set<() => void>();
const subscribeToOwners = (listener: () => void) => {
  ownerListeners.add(listener);
  return () => ownerListeners.delete(listener);
};
const notifyOwners = () => ownerListeners.forEach((listener) => listener());

/** Keeps the renderer mounted while this component is mounted. Render it from every diagram block. */
export function MermaidRendererPortal() {
  const [id] = useState(() => Symbol('mermaid-renderer-owner'));
  useEffect(() => {
    owners.push(id);
    notifyOwners();
    return () => {
      owners.splice(owners.indexOf(id), 1);
      notifyOwners();
    };
  }, [id]);
  const isOwner = useSyncExternalStore(subscribeToOwners, () => owners[0] === id);
  if (!isOwner) return null;
  return (
    <Portal name={PORTAL_NAME}>
      <MermaidRendererHost />
    </Portal>
  );
}

const subscribeToQueue = (listener: () => void) => mermaidRenderQueue.subscribe(listener);
const isRendererWanted = () => mermaidRenderQueue.isWanted();

export function MermaidRendererHost() {
  const wanted = useSyncExternalStore(subscribeToQueue, isRendererWanted);
  const [source, setSource] = useState<string | null>(loadedSource);
  // Bumped to remount the WebView after its content process dies.
  const [generation, setGeneration] = useState(0);
  const webViewRef = useRef<WebView>(null);

  useEffect(() => {
    if (!wanted || source) return;
    let cancelled = false;
    loadMermaidSource().then(
      (text) => {
        if (!cancelled) setSource(text);
      },
      (error: unknown) => {
        log.error('Mermaid renderer: failed to load mermaid.min.webjs', error);
        if (!cancelled) mermaidRenderQueue.failAll('renderer unavailable');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [wanted, source]);

  useEffect(() => () => mermaidRenderQueue.detach(), []);

  const onLoadEnd = useCallback(() => {
    if (source) webViewRef.current?.injectJavaScript(rendererBootScript(source));
  }, [source]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const kind = mermaidRenderQueue.handleMessage(event.nativeEvent.data);
    if (kind === 'ready') {
      mermaidRenderQueue.attach((script) => webViewRef.current?.injectJavaScript(script));
    } else if (kind === 'fatal') {
      log.error('Mermaid renderer: initialization failed', event.nativeEvent.data);
    }
  }, []);

  const remount = useCallback(() => {
    log.warn('Mermaid renderer: WebView process ended, remounting');
    mermaidRenderQueue.detach();
    setGeneration((value) => value + 1);
  }, []);

  if (!wanted || !source) return null;

  return (
    <View pointerEvents="none" style={styles.host} importantForAccessibility="no-hide-descendants">
      <WebView
        key={generation}
        ref={webViewRef}
        source={RENDERER_SOURCE}
        originWhitelist={ORIGIN_WHITELIST}
        onShouldStartLoadWithRequest={allowInlineDocumentLoad}
        onLoadEnd={onLoadEnd}
        onMessage={onMessage}
        onContentProcessDidTerminate={remount}
        onRenderProcessGone={remount}
        javaScriptEnabled
        scrollEnabled={false}
        cacheEnabled={false}
        incognito
        style={styles.webView}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Off-screen but laid out: a zero-size or detached WebView may not run
  // script on Android. Mermaid lays out in its own 800px scratch element.
  host: { position: 'absolute', top: 0, left: 0, width: 320, height: 320, opacity: 0 },
  webView: { flex: 1, backgroundColor: 'transparent' },
});
