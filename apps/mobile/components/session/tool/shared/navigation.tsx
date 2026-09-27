/**
 * Where a tool row sends the reader: files, sessions, previews, links.
 *
 * Mirrors apps/web `tool/shared/infrastructure.tsx` `ToolNavigationContext` /
 * `useToolNavigation` / `useProxyUrl` / `useServicePreview` /
 * `ServicePreviewActions` / `ServicePreviewViewport` /
 * `ServicePreviewUrlFallback` / `InlineServicePreview`, adapted to mobile's
 * mechanisms:
 * - a FILE opens in `FilePreviewSheet` (the sheet every other file-open on mobile
 *   uses) through `useToolFilePreviewStore` — web's `useFilePreviewStore`
 *   equivalent. `ToolFilePreviewHost` renders that viewer and must be mounted
 *   once per screen that shows tool rows (the session screen);
 * - a SESSION opens through `useTabStore().navigateToSession`;
 * - a sandbox PREVIEW (localhost URL) opens the Browser page tab
 *   (`page:browser`) on the sandbox proxy URL, as `SandboxPreviewCard` does;
 * - an EXTERNAL link opens with `openLink` (http/https only): kortix.com in
 *   the in-app browser, any other site in the system browser.
 *
 * Mobile has no iframe, so `ServicePreviewViewport` is a tappable card that
 * opens the Browser tab instead of an embedded page.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { create } from 'zustand';
import { isProxiableLocalhostUrl, parseLocalhostUrl } from '@kortix/sdk';
import type { SandboxFile } from '@/api/types';
import { FilePreviewSheet, type PreviewFile } from '@/components/files/FilePreviewSheet';
import type { SheetRef } from '@/components/kortix/sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';

import { ResultRow } from './result-row';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { THEME } from '@/lib/utils/theme';
import { ArrowSquareOutIcon, CaretRightIcon, GlobeIcon, MonitorIcon } from '@/lib/icons';
import { getSandboxPortUrl } from '@/lib/platform/client';
import { webSpace } from '@/lib/session/user-message';
import { useTabStore } from '@/stores/tab-store';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from './styles';
import { ToolSurfaceContext } from './surface';
import { openLink } from '@/lib/utils/open-link';

/** `false` inside a surface where tool rows must not navigate (sub-agent lists). */
export const ToolNavigationContext = createContext(true);

// ─── File preview (web `useFilePreviewStore`) ───────────────────────────────

interface ToolFilePreviewState {
  path: string | null;
  line: number | undefined;
  openPreview: (path: string, line?: number) => void;
  closePreview: () => void;
}

export const useToolFilePreviewStore = create<ToolFilePreviewState>()((set) => ({
  path: null,
  line: undefined,
  openPreview: (path, line) => set({ path, line }),
  closePreview: () => set({ path: null, line: undefined }),
}));

/**
 * The one file preview tool rows open files into: `FilePreviewSheet`, the
 * sheet Recent files opens (Jay, 2026-09-22 — never the full-screen
 * `FileViewer` again). Mount it once on the screen that renders the
 * transcript; without it `openFile` records the request and nothing opens.
 *
 * No "Add to chat" here: that button writes a mention into the composer, which
 * only `SessionChatInput` owns.
 */
export function ToolFilePreviewHost() {
  const path = useToolFilePreviewStore((s) => s.path);
  const closePreview = useToolFilePreviewStore((s) => s.closePreview);
  const { sandboxUrl } = useSandboxContext();
  const sheetRef = useRef<SheetRef>(null);
  const file = useMemo<PreviewFile | null>(() => {
    if (!path) return null;
    const fullPath = path.startsWith('/') ? path : `/workspace/${path}`;
    return { name: fullPath.split('/').pop() || fullPath, path: fullPath };
  }, [path]);

  // The store is the source of truth: a row's tap sets the path, which opens
  // the sheet; the sheet's close clears it.
  useEffect(() => {
    if (file) sheetRef.current?.open();
  }, [file]);

  return (
    <FilePreviewSheet ref={sheetRef} file={file} sandboxUrl={sandboxUrl} onDismiss={closePreview} />
  );
}

// ─── useToolNavigation ───────────────────────────────────────────────────────

/** Web's `openTabAndNavigate` tab shape; mobile reads `type` to pick the target. */
export interface ToolNavigationTab {
  id: string;
  title: string;
  type: 'session' | 'preview' | 'file' | (string & {});
  href?: string;
  metadata?: Record<string, unknown>;
}

function openBrowserTab(url: string, display: string) {
  const tabs = useTabStore.getState();
  tabs.navigateToPage('page:browser');
  tabs.setTabState('page:browser', { savedUrl: url, savedDisplay: display });
}

function safeHttpUrl(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

export function useToolNavigation() {
  const enabled = useContext(ToolNavigationContext);

  const openFile = useCallback(
    (path: string, line?: number) => {
      if (!enabled || !path) return;
      useToolFilePreviewStore.getState().openPreview(path, line);
    },
    [enabled],
  );

  const openSession = useCallback(
    (sessionId: string) => {
      if (!enabled || !sessionId) return;
      useTabStore.getState().navigateToSession(sessionId);
    },
    [enabled],
  );

  const openExternal = useCallback(
    (targetUrl?: string) => {
      const safe = safeHttpUrl(targetUrl);
      if (!enabled || !safe) return;
      openLink(safe).catch(() => {});
    },
    [enabled],
  );

  const openTab = useCallback(
    (tab: ToolNavigationTab) => {
      if (!enabled) return;
      if (tab.type === 'session') {
        useTabStore.getState().navigateToSession(tab.id);
        return;
      }
      if (tab.type === 'preview') {
        const url = typeof tab.metadata?.url === 'string' ? tab.metadata.url : undefined;
        if (url) openBrowserTab(url, tab.title);
        return;
      }
      if (tab.type === 'file') {
        const path = typeof tab.metadata?.path === 'string' ? tab.metadata.path : tab.id;
        useToolFilePreviewStore.getState().openPreview(path);
      }
    },
    [enabled],
  );

  return { enabled, openTab, openExternal, openFile, openSession };
}

// ─── Sandbox previews ────────────────────────────────────────────────────────

/** A localhost URL → the sandbox proxy URL for its port, or `null`. */
export function useProxyUrl(localhostUrl: string): { proxyUrl: string; port: number } | null {
  const { sandboxId } = useSandboxContext();
  return useMemo(() => {
    if (!localhostUrl || !sandboxId) return null;
    if (!isProxiableLocalhostUrl(localhostUrl)) return null;
    const parsed = parseLocalhostUrl(localhostUrl);
    if (!parsed) return null;
    const path = parsed.path === '/' ? '' : parsed.path;
    return { proxyUrl: getSandboxPortUrl(sandboxId, String(parsed.port)) + path, port: parsed.port };
  }, [localhostUrl, sandboxId]);
}

export function useServicePreview(url: string, label?: string, _sessionId?: string) {
  const { enabled: navigationEnabled, openExternal } = useToolNavigation();
  const proxy = useProxyUrl(url);
  const externalUrl = proxy ? null : safeHttpUrl(url);
  const previewUrl = proxy ? proxy.proxyUrl : externalUrl;
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const displayLabel = label || (proxy ? 'App preview' : url);

  const navigateToPreviewTab = useCallback(() => {
    if (!navigationEnabled || !previewUrl) return;
    const parsed = parseLocalhostUrl(url);
    openBrowserTab(previewUrl, parsed ? `localhost:${parsed.port}${parsed.path === '/' ? '' : parsed.path}` : displayLabel);
  }, [displayLabel, navigationEnabled, previewUrl, url]);

  // A sandbox proxy URL needs the app's auth, which the system browser does
  // not carry, so it opens in the in-app Browser tab; a public URL opens
  // externally.
  const openInBrowser = useCallback(() => {
    if (proxy) navigateToPreviewTab();
    else openExternal(previewUrl ?? undefined);
  }, [navigateToPreviewTab, openExternal, previewUrl, proxy]);

  return {
    navigationEnabled,
    proxy,
    previewUrl,
    /** Mobile loads nothing inline, so a preview is never loading or failed. */
    isLoading: false,
    hasError: false,
    refreshKey,
    handleRefresh,
    displayLabel,
    navigateToPreviewTab,
    openInBrowser,
    onLoad: noop,
    onError: noop,
  };
}

function noop() {}

export type ServicePreviewState = ReturnType<typeof useServicePreview>;

/** Web: refresh · open externally · "Open as tab". Mobile: open externally · Open. */
export function ServicePreviewActions({ preview }: { preview: ServicePreviewState }) {
  const palette = useTurnPalette();
  const { navigationEnabled, previewUrl, navigateToPreviewTab, openInBrowser } = preview;
  const disabled = !navigationEnabled || !previewUrl;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1), flexShrink: 0 }}>
      <Button
        variant="ghost"
        size="icon"
        disabled={disabled}
        onPress={openInBrowser}
        accessibilityLabel="Open in browser"
      >
        <Icon as={ArrowSquareOutIcon} size={TURN_SPACE.icon} color={palette.mutedForeground} />
      </Button>
      <Button variant="secondary" size="sm" disabled={disabled} onPress={navigateToPreviewTab}>
        <Text>Open</Text>
      </Button>
    </View>
  );
}

/**
 * A running app in the transcript: ONE row, the same shape as a `show`
 * output's row (COR-107; Jay, 2026-09-22). It replaces the old block — a mono
 * URL strip with a globe, a grey viewport box, an outline button repeating the
 * label, and two more controls — which asked the reader to find the target
 * among five elements. The row is the target: a screen glyph, "App preview",
 * the port under it, a chevron. The token-bearing proxy URL is never shown.
 */
export function ServicePreviewRow({ preview, url }: { preview: ServicePreviewState; url: string }) {
  const { displayLabel, navigationEnabled, previewUrl, navigateToPreviewTab } = preview;
  const disabled = !navigationEnabled || !previewUrl;
  const parsed = parseLocalhostUrl(url);
  const where = parsed
    ? `localhost:${parsed.port}${parsed.path && parsed.path !== '/' ? parsed.path : ''}`
    : 'Live preview';

  return (
    <ResultRow
      icon={MonitorIcon}
      title={displayLabel && displayLabel !== url ? displayLabel : 'App preview'}
      subtitle={where}
      onPress={disabled ? undefined : navigateToPreviewTab}
    />
  );
}

/** The tappable body of a preview: label + Open. Never renders the token-bearing URL. */
export function ServicePreviewUrlFallback({ preview }: { preview: ServicePreviewState }) {
  const palette = useTurnPalette();
  const { displayLabel, navigationEnabled, previewUrl, navigateToPreviewTab } = preview;
  return (
    <Button
      variant="outline"
      disabled={!navigationEnabled || !previewUrl}
      onPress={navigateToPreviewTab}
      accessibilityLabel={`Open ${displayLabel}`}
    >
      <Icon as={ArrowSquareOutIcon} size={TURN_SPACE.icon} color={palette.mutedForeground} />
      <Text numberOfLines={1}>{displayLabel}</Text>
    </Button>
  );
}

export function ServicePreviewViewport({ preview, url = '' }: { preview: ServicePreviewState; url?: string }) {
  const palette = useTurnPalette();
  const fill = useContext(ToolSurfaceContext) === 'panel';
  // In the transcript the preview IS the row; only the panel draws a viewport.
  if (!fill) return <ServicePreviewRow preview={preview} url={url} />;
  return (
    <View
      style={{
        backgroundColor: palette.muted,
        alignItems: 'center',
        justifyContent: 'center',
        padding: webSpace(6),
        ...(fill ? { flex: 1 } : { aspectRatio: 16 / 9 }),
      }}
    >
      <ServicePreviewUrlFallback preview={preview} />
    </View>
  );
}

export function InlineServicePreview({ url, label }: { url: string; label?: string }) {
  const palette = useTurnPalette();
  const preview = useServicePreview(url, label);
  const fill = useContext(ToolSurfaceContext) === 'panel';
  if (!fill) return <ServicePreviewRow preview={preview} url={url} />;
  return (
    <View style={{ overflow: 'hidden' }}>
      <View
        style={{
          height: webSpace(8),
          flexDirection: 'row',
          alignItems: 'center',
          gap: TURN_SPACE.gap1_5,
          paddingHorizontal: webSpace(2.5),
          backgroundColor: palette.muted40Bg,
          borderBottomWidth: 1,
          borderBottomColor: palette.border30,
        }}
      >
        <GlobeIcon size={TURN_SPACE.statusIcon} color={palette.muted50} />
        <Text
          variant="muted"
          numberOfLines={1}
          style={[TURN_TYPE.xs, { flex: 1, fontFamily: monoFont, color: palette.mutedForeground }]}
        >
          {preview.displayLabel}
        </Text>
      </View>
      <ServicePreviewViewport preview={preview} />
    </View>
  );
}
