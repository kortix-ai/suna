/**
 * The activity sheet — what a burst's summary row opens on mobile.
 *
 * A `KortixBottomSheetModal` (40% of the screen, drag up to full) with a
 * timeline of everything the agent did in the burst (`activitySheetEntries`):
 * a tool call is a bordered icon tile and its step label. Thinking never
 * shows. A thin rail joins the markers. A running entry's title shimmers; with
 * parallel calls only the last running one sweeps, the others hold still.
 * Tapping an entry pushes its detail, the call's body, inside the same sheet.
 * Back returns to the list.
 *
 * The title row is the app's one (`SheetTitleRow`): close at the far left, the
 * title centred. In a detail, Back takes the close button's slot.
 *
 * `ActivitySheetHost` is mounted once by the transcript screen and renders the
 * sheet from `useActivitySheetStore`. The owning burst row keeps the store's
 * view live, and the sheet outlives the row (a re-keyed, bare, or unmounted
 * burst leaves the last view on screen). The sheet steps aside for a pending
 * permission prompt on one of its calls and for any tab navigation.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Pressable, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isToolPart, type ToolPart } from '@kortix/sdk';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixBottomSheetModal, SheetTitleRow } from '@/components/kortix/sheet';
import { POP_IN, PUSH_IN, SheetBackButton } from '@/components/kortix/sheet-push';
import { LoopMotionContext, TextShimmer } from '@/components/kortix/text-shimmer';
import { CodeBlockFullHeightContext } from '@/components/markdown/code-block';
import { MarkdownActionsProvider, type MarkdownActions } from '@/components/markdown/inline-code';
import { usePendingPermissions } from '@/lib/session/session-store';
import { activitySheetEntries, burstHasPendingPermission, type ActivitySheetEntry } from '@/lib/session/activity-sheet';
import { useActivitySheetStore } from '@/lib/session/activity-sheet-store';
import { useTabStore } from '@/stores/tab-store';
import { ToolPartRenderer } from '@/components/session/tool/tool-part-renderer';
import '@/components/session/tool/tools/register';
import { FONT_MEDIUM, TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';
import { ToolDetailContext } from '@/components/session/tool/shared/surface';
import {
  ConnectorHandoffContext,
  type ConnectorHandoffApi,
  type ConnectorHandoffRequest,
} from '@/components/session/tool/shared/connector-handoff-context';
import { ACTIVITY_ICONS } from '@/components/session/tool/shared/tool-icons';
import type { ActivityContextValue } from '@/lib/session/activity-sheet-store';

/**
 * Lengths in pt, measured on the reference sheet (1080px @3x) unless noted.
 */
const SHEET = {
  // Chrome: top corner radius; header row height; X / back glyph centred 38pt
  // from the edge (18 + 40pt icon button / 2); glyph size.
  radius: 36,
  // Content: tile left edge 18pt; 12pt under the header; 24pt above the home indicator.
  padX: 18,
  padTop: 12,
  padBottom: 24,
  // Marker column: tile size, equal to one 24pt text line so markers centre on line 1.
  marker: 24,
  tileRadius: 7,
  tileIcon: 14,
  // Marker to text 16pt (text starts at 58pt); 20pt between entries.
  markerGap: 16,
  entryGap: 20,
  // Rail clearance from a marker's edge: 3pt.
  railGap: 3,
} as const;

/** Opens at 40% of the screen (Jay, 2026-09-17); drag up for the full height. */
const SNAP_POINTS = ['40%', '100%'];

// ─── Timeline ────────────────────────────────────────────────────────────────

function EntryMarker({ entry }: { entry: ActivitySheetEntry }) {
  const palette = useTurnPalette();
  const Icon = ACTIVITY_ICONS[entry.icon];
  return (
    <View
      style={{
        width: SHEET.marker,
        height: SHEET.marker,
        borderRadius: SHEET.tileRadius,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.background,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon size={SHEET.tileIcon} color={entry.failed ? palette.destructive : palette.foreground} />
    </View>
  );
}

const TOOL_TITLE = [TURN_TYPE.sheetEntry, { fontFamily: FONT_MEDIUM }];

function EntryTitle({ entry }: { entry: ActivitySheetEntry }) {
  const palette = useTurnPalette();
  if (entry.running) {
    return (
      <TextShimmer tone="default" style={TOOL_TITLE} numberOfLines={2}>
        {entry.title}
      </TextShimmer>
    );
  }
  return (
    <Text numberOfLines={2} style={[TOOL_TITLE, { color: palette.foreground }]}>
      {entry.title}
    </Text>
  );
}

function TimelineEntry({
  entry,
  next,
  onOpen,
}: {
  entry: ActivitySheetEntry;
  next?: ActivitySheetEntry;
  onOpen: (key: string) => void;
}) {
  const palette = useTurnPalette();
  // The row layout lives on a plain View. NativeWind's css-interop drops a
  // function `style` on `Pressable`, which stacked the marker above the title
  // and ran the rail through the text; press feedback is an `active:` class.
  return (
    <Pressable
      accessibilityRole={entry.openable ? 'button' : undefined}
      accessibilityHint={entry.openable ? 'Opens the details' : undefined}
      disabled={!entry.openable}
      onPress={() => onOpen(entry.key)}
      className="active:opacity-60"
    >
      <View style={{ flexDirection: 'row', gap: SHEET.markerGap, paddingBottom: next ? SHEET.entryGap : 0 }}>
        <View style={{ width: SHEET.marker, height: SHEET.marker, alignItems: 'center', justifyContent: 'center' }}>
          <EntryMarker entry={entry} />
        </View>
        {next ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: SHEET.marker / 2,
              width: 1,
              top: SHEET.marker + SHEET.railGap,
              bottom: SHEET.railGap,
              backgroundColor: palette.border,
            }}
          />
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <EntryTitle entry={entry} />
        </View>
      </View>
    </Pressable>
  );
}

// ─── Detail ──────────────────────────────────────────────────────────────────

function EntryDetail({ entry, context }: { entry: ActivitySheetEntry; context: ActivityContextValue }) {
  if (!isToolPart(entry.part)) return null;
  return (
    <ToolDetailContext.Provider value="body">
      <ToolPartRenderer
        part={entry.part as ToolPart}
        sessionId={context.sessionId}
        turnLive={context.turnLive}
        onPermissionReply={context.onPermissionReply}
      />
    </ToolDetailContext.Provider>
  );
}

// ─── Sheet ───────────────────────────────────────────────────────────────────

/**
 * The app's one sheet title row (`SheetTitleRow`): close at the far left, the
 * title centred. In a detail, Back takes the close button's slot.
 */
function ActivitySheetHeader({ title, onBack, onClose }: { title: string; onBack?: () => void; onClose: () => void }) {
  return (
    <SheetTitleRow
      title={title}
      onClose={onClose}
      leading={onBack ? <SheetBackButton onPress={onBack} /> : undefined}
    />
  );
}

interface ActivitySheetProps {
  entries: ReadonlyArray<ActivitySheetEntry>;
  /**
   * The burst's session, liveness, and permission replies, plus the screen's
   * markdown actions. Passed as props: gorhom renders the sheet in its portal
   * host, outside the transcript's providers.
   */
  context: ActivityContextValue;
  markdownActions?: MarkdownActions;
  /**
   * The transcript's connector hand-off (COR-158). A connector call that asks
   * for a connect renders as its own transcript row (`standaloneCallIdsFor`),
   * so this is a guard: a Connect tapped in here first dismisses this sheet,
   * and the auth sheet opens only once this one is gone — never two overlays.
   */
  connectorHandoff?: ConnectorHandoffApi | null;
  /** Dismiss now, animated (a permission prompt needs the screen). */
  dismissRequested: boolean;
  onDismiss: () => void;
}

function ActivitySheetImpl({
  entries,
  context,
  markdownActions,
  connectorHandoff,
  dismissRequested,
  onDismiss,
}: ActivitySheetProps) {
  const ref = useRef<BottomSheetModal>(null);
  // A Connect tapped inside this sheet: held until the sheet has dismissed.
  const pendingConnectRef = useRef<ConnectorHandoffRequest | null>(null);
  const handoffValue = useMemo<ConnectorHandoffApi | null>(
    () =>
      connectorHandoff
        ? {
            projectId: connectorHandoff.projectId,
            requestConnect: (request) => {
              pendingConnectRef.current = request;
              ref.current?.dismiss();
            },
          }
        : null,
    [connectorHandoff],
  );
  const handleDismiss = useCallback(() => {
    onDismiss();
    const request = pendingConnectRef.current;
    pendingConnectRef.current = null;
    if (request) connectorHandoff?.requestConnect(request);
  }, [onDismiss, connectorHandoff]);
  const insets = useSafeAreaInsets();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // The list animates only when it comes back from a detail, never on open.
  const [returning, setReturning] = useState(false);

  useEffect(() => {
    ref.current?.present();
  }, []);

  useEffect(() => {
    if (dismissRequested) ref.current?.dismiss();
  }, [dismissRequested]);

  const close = useCallback(() => ref.current?.dismiss(), []);
  const open = useCallback((key: string) => setSelectedKey(key), []);
  const back = useCallback(() => {
    setReturning(true);
    setSelectedKey(null);
  }, []);

  // Android back: the first press leaves the detail, the next closes the sheet.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectedKey) back();
      else close();
      return true;
    });
    return () => subscription.remove();
  }, [selectedKey, back, close]);

  const selected = selectedKey ? entries.find((entry) => entry.key === selectedKey) : undefined;
  const lastRunning = entries.map((entry) => entry.running).lastIndexOf(true);
  const contentStyle = {
    paddingHorizontal: SHEET.padX,
    paddingTop: SHEET.padTop,
    paddingBottom: insets.bottom + SHEET.padBottom,
  };

  return (
    <KortixBottomSheetModal
      ref={ref}
      snapPoints={SNAP_POINTS}
      enableDynamicSizing={false}
      enablePanDownToClose
      topInset={insets.top}
      onDismiss={handleDismiss}
    >
      <ConnectorHandoffContext.Provider value={handoffValue}>
      <MarkdownActionsProvider value={markdownActions ?? NO_MARKDOWN_ACTIONS}>
        {selected ? (
          <Animated.View key={selected.key} entering={PUSH_IN} style={{ flex: 1 }}>
            <ActivitySheetHeader title={selected.title} onBack={back} onClose={close} />
            <BottomSheetScrollView contentContainerStyle={contentStyle}>
              <CodeBlockFullHeightContext.Provider value>
                <EntryDetail entry={selected} context={context} />
              </CodeBlockFullHeightContext.Provider>
            </BottomSheetScrollView>
          </Animated.View>
        ) : (
          <Animated.View key="list" entering={returning ? POP_IN : undefined} style={{ flex: 1 }}>
            <ActivitySheetHeader title="Activity" onClose={close} />
            <BottomSheetScrollView contentContainerStyle={contentStyle}>
              {entries.map((entry, index) => (
                // Parallel calls run together: only the last running entry sweeps.
                <LoopMotionContext.Provider key={entry.key} value={index === lastRunning}>
                  <TimelineEntry entry={entry} next={entries[index + 1]} onOpen={open} />
                </LoopMotionContext.Provider>
              ))}
            </BottomSheetScrollView>
          </Animated.View>
        )}
      </MarkdownActionsProvider>
      </ConnectorHandoffContext.Provider>
    </KortixBottomSheetModal>
  );
}

const NO_MARKDOWN_ACTIONS: MarkdownActions = {};

const ActivitySheet = memo(ActivitySheetImpl);

// ─── Host ────────────────────────────────────────────────────────────────────


/**
 * Mount once per transcript screen, next to `ToolFilePreviewHost`. It shows the
 * sheet only for its own session, so two mounted transcripts never both
 * present it. Without a host the summary row opens nothing.
 */
export function ActivitySheetHost({
  sessionId: hostSessionId,
  markdownActions,
  connectorHandoff,
}: {
  sessionId: string;
  markdownActions?: MarkdownActions;
  /** The transcript's connector hand-off; see `ActivitySheetProps`. */
  connectorHandoff?: ConnectorHandoffApi | null;
}) {
  const store = useActivitySheetStore((state) => state.sheet);
  const sheet = store?.context.sessionId === hostSessionId ? store : null;
  const closeSheet = useActivitySheetStore((state) => state.close);
  const sessionId = sheet?.context.sessionId;
  const permissions = usePendingPermissions(sessionId);
  const view = sheet?.view;
  const entries = useMemo(() => (view ? activitySheetEntries(view) : []), [view]);

  // Navigating to another tab or page leaves the transcript: the sheet goes with it.
  useEffect(
    () =>
      useTabStore.subscribe((state, previous) => {
        if (state.activeSessionId !== previous.activeSessionId || state.activePageId !== previous.activePageId) {
          closeSheet();
        }
      }),
    [closeSheet],
  );

  // The host outlives every burst; the sheet never outlives the host.
  useEffect(
    () => () => {
      if (useActivitySheetStore.getState().sheet?.context.sessionId === hostSessionId) closeSheet();
    },
    [closeSheet, hostSessionId],
  );

  if (!sheet) return null;
  return (
    <ActivitySheet
      entries={entries}
      context={sheet.context}
      markdownActions={markdownActions}
      connectorHandoff={connectorHandoff}
      dismissRequested={burstHasPendingPermission(sheet.callIds, permissions)}
      onDismiss={closeSheet}
    />
  );
}
