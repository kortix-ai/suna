/**
 * AppsPage (`page:apps`) — the project's Apps, the web Apps page's cards
 * (`apps-view.tsx`): one compact card per App — a live preview of its page
 * on top, then its name and runtime state — and a tap that opens it, the same
 * two hops web's `?open_app=` link runs, a short-lived access session then
 * the URL, in the in-app browser instead of an iframe. Apps are deployed from
 * a sandbox with `kortix apps deploy`, so the page has no create action and
 * no search: it is a list you open things from.
 *
 * The preview (KRTX-2183; rules in `lib/projects/app-preview.ts`) is a
 * WebView that takes no input, mounted only while its card is on screen, the
 * page is focused, the app is in the foreground and no App is open in the
 * browser; at most `PREVIEW_CONCURRENCY` exist at once. A preview that fails
 * or takes longer than `PREVIEW_TIMEOUT_MS` shows the App glyph until the
 * next pull to refresh.
 */

import { type App, createAppAccessSession, listApps } from '@kortix/sdk';
import { useAppAccess } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import { useColorScheme } from 'nativewind';
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Pressable, View, type ViewToken } from 'react-native';
import { WebView } from 'react-native-webview';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PageContent } from '@/components/kortix/page-content';
import { PageHeader } from '@/components/kortix/page-header';
import { PageList } from '@/components/kortix/page-list';
import { SettingsGroupItem, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { Icon } from '@/components/ui/icon';
import { haptics } from '@/lib/haptics';
import { LockIcon, SquaresFourIcon } from '@/lib/icons';
import {
  PREVIEW_ASPECT,
  PREVIEW_INJECTED_JS,
  PREVIEW_TIMEOUT_MS,
  allowPreviewNavigation,
  appPreviewState,
  createPreviewSlots,
  type PreviewSlots,
} from '@/lib/projects/app-preview';
import { AppAccessDeniedError, appStatus, openApp } from '@/lib/projects/apps';
import { projectKeys } from '@/lib/projects/hooks';
import { openLink } from '@/lib/utils/open-link';
import { THEME } from '@/lib/utils/theme';
import { decidePreviewNavigation } from '@/lib/utils/html-embed';

import type { PageTab } from '@/stores/tab-store';

interface AppsPageProps {
  page: PageTab;
  projectId: string;
  onOpenDrawer?: () => void;
}

const VIEWABILITY = { itemVisiblePercentThreshold: 10 };

/** One preview per release: a new deployment loads again. */
const previewKey = (app: App) => `${app.app_id}:${app.active_deployment_id ?? 'none'}`;

export function AppsPage({ page, projectId, onOpenDrawer }: AppsPageProps) {
  const { colorScheme } = useColorScheme();
  const bgColor = colorScheme === 'dark' ? THEME.dark.background : THEME.light.background;
  const toast = useToast();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: projectKeys.apps(projectId),
    queryFn: () => listApps(projectId),
    enabled: !!projectId,
    staleTime: 10_000,
  });
  const apps = data ?? [];

  // Previews run only while someone can see them.
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setForeground(state === 'active'),
    );
    return () => subscription.remove();
  }, []);
  // An App open in the in-app browser: iOS keeps AppState active under it.
  const [browsing, setBrowsing] = useState(false);
  const previewsOn = focused && foreground && !browsing;

  const [slots] = useState(createPreviewSlots);
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  // FlatList refuses a changed `onViewableItemsChanged`: keep one function.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    setVisible(new Set(viewableItems.map((item) => item.key)));
  }).current;

  // Failed previews stay on their fallback until a pull to refresh.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [generation, setGeneration] = useState(0);
  const markFailed = useCallback((key: string) => {
    setFailed((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);
  const refresh = useCallback(() => {
    setFailed(new Set());
    setGeneration((value) => value + 1);
    return refetch();
  }, [refetch]);

  const openOne = useCallback(
    (app: App) => {
      haptics.tap();
      setBrowsing(true);
      void openApp(app, {
        createSession: () => createAppAccessSession(projectId, app.app_id),
        openLink,
      })
        .catch((openError: unknown) => {
          toast.error(
            openError instanceof AppAccessDeniedError
              ? openError.message
              : openError instanceof Error
                ? openError.message
                : 'Could not open this app',
          );
        })
        .finally(() => setBrowsing(false));
    },
    [projectId, toast],
  );

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader title={page.label} onOpenDrawer={onOpenDrawer} />

      <PageContent>
        <PageList<App>
          isLoading={isLoading}
          errorMessage={
            isError && apps.length === 0
              ? ((error as Error)?.message ?? 'Unable to load apps')
              : null
          }
          onRetry={() => void refetch()}
          onRefresh={refresh}
          emptyLabel={apps.length === 0 ? 'No apps yet' : null}
          header={<View className="h-1" />}
          data={apps}
          keyExtractor={(app) => app.app_id}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={VIEWABILITY}
          renderItem={(app) => (
            <AppCard
              app={app}
              projectId={projectId}
              slots={slots}
              onScreen={previewsOn && visible.has(app.app_id)}
              failed={failed.has(previewKey(app))}
              generation={generation}
              onFail={markFailed}
              onOpen={openOne}
            />
          )}
        />
      </PageContent>
    </View>
  );
}

function AppCard({
  app,
  projectId,
  slots,
  onScreen,
  failed,
  generation,
  onFail,
  onOpen,
}: {
  app: App;
  projectId: string;
  slots: PreviewSlots;
  onScreen: boolean;
  failed: boolean;
  generation: number;
  onFail: (key: string) => void;
  onOpen: (app: App) => void;
}) {
  const state = appPreviewState(app);
  const denied = state === 'denied';
  const key = previewKey(app);
  const wantsPreview = state === 'live' && onScreen && !failed;

  useEffect(() => {
    if (!wantsPreview) return;
    slots.want(key);
    return () => slots.drop(key);
  }, [wantsPreview, slots, key]);
  const hasSlot = useSyncExternalStore(slots.subscribe, () => slots.granted(key));
  const granted = wantsPreview && hasSlot;

  // The same cached access session web's card uses (4 min fresh, 5 min valid).
  const access = useAppAccess(projectId, app.app_id, { policy: false, session: granted });
  const sessionFailed = granted && access.session.isError;
  useEffect(() => {
    if (sessionFailed) onFail(key);
  }, [sessionFailed, onFail, key]);
  const url = granted ? access.session.data?.url : undefined;

  return (
    <View className="px-4 pb-3">
      <SettingsGroupItem index={0} count={1}>
        <Pressable
          onPress={() => onOpen(app)}
          disabled={denied}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          className="bg-muted active:opacity-80"
          style={{ aspectRatio: PREVIEW_ASPECT, opacity: denied ? 0.5 : 1 }}>
          {url ? (
            <AppPreviewFrame key={`${key}:${generation}`} url={url} onFail={() => onFail(key)} />
          ) : granted ? (
            <View className="flex-1 items-center justify-center">
              <KortixLoader />
            </View>
          ) : (
            <View className="flex-1 items-center justify-center">
              <Icon
                as={denied ? LockIcon : SquaresFourIcon}
                size={24}
                className="text-muted-foreground/70"
              />
            </View>
          )}
        </Pressable>
        <SettingsRow
          icon={SquaresFourIcon}
          label={app.name}
          value={denied ? 'No access' : appStatus(app)}
          disabled={denied}
          external={!denied}
          onPress={() => onOpen(app)}
        />
      </SettingsGroupItem>
    </View>
  );
}

/**
 * The page itself, laid out at a desktop width and scaled into the card
 * (`PREVIEW_INJECTED_JS`). No input: `pointerEvents="none"` sends every touch
 * to the card. Hidden behind the loader until it has loaded. A new pull to
 * refresh (`generation`) or a new release (`previewKey`) mounts a fresh one.
 */
function AppPreviewFrame({ url, onFail }: { url: string; onFail: () => void }) {
  // Read once: a refetched access session mints a new URL, and following it
  // would reload a preview that is already showing.
  const [source] = useState(() => ({ uri: url }));
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!loadedRef.current) onFailRef.current();
    }, PREVIEW_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View className="flex-1" pointerEvents="none">
      <WebView
        source={source}
        style={{ flex: 1, backgroundColor: 'transparent', opacity: loaded ? 1 : 0 }}
        injectedJavaScriptBeforeContentLoaded={PREVIEW_INJECTED_JS}
        javaScriptEnabled
        scalesPageToFit
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        mediaPlaybackRequiresUserAction
        mediaCapturePermissionGrantType="deny"
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        allowsLinkPreview={false}
        textInteractionEnabled={false}
        geolocationEnabled={false}
        // `*`: every navigation reaches the guard below. With the library's
        // default http(s)-only whitelist, a `tel:` / `mailto:` / deep-link
        // URL goes straight to `Linking.openURL` and the guard never runs
        // (Strix CWE-749). The guard then allows only http(s), first load only.
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={(request) =>
          decidePreviewNavigation(request.url, { mode: 'browser' }) === 'allow' &&
          allowPreviewNavigation(loadedRef.current, request.isTopFrame)
        }
        onLoad={() => {
          loadedRef.current = true;
          setLoaded(true);
        }}
        onError={() => onFailRef.current()}
        onHttpError={() => onFailRef.current()}
      />
      {loaded ? null : (
        <View className="absolute inset-0 items-center justify-center">
          <KortixLoader />
        </View>
      )}
    </View>
  );
}
