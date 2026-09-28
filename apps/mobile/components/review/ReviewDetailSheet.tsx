/**
 * ReviewDetailSheet — one review item, with the verdicts its kind offers.
 *
 * One sheet: the item's title, a Details group of aligned label · value rows
 * (`reviewDetailRows`), then one body per kind:
 * - change: what changed, the agent's checks, then its Files — one row per
 *   changed file with its +/− counts, no diff drawn. A file row pushes that
 *   file's diff inside the sheet (`ReviewFileDiff`, virtualized; Back returns),
 *   and "Open on web" opens the change request on kortix.com (Jay, 2026-09-27:
 *   the whole diff in the sheet stalled the device).
 * - approval: each connector call with its arguments. Arguments the viewer may
 *   not see are named as hidden, never shown as empty.
 * - decision: the question and its options. Choosing one answers.
 * - output: the agent's note, a text preview, a link to the live preview.
 * - batch: the finished items, one sign-off.
 *
 * A change offers Merge and Request changes, side by side, in the footer; its
 * Close is the sheet's last row instead (Jay, 2026-09-21 / 2026-09-27). While its merge preview reports conflicts, Merge reads
 * "Resolve conflicts" (Jay, 2026-09-27): it closes the sheet, opens the
 * session that opened the change — never a new one — and sends it the
 * resolve prompt (`change-request-recovery.ts`). A change opened by hand with
 * no session (`origin_session_id` null) has no session to open: the button
 * shows disabled. An agent's change always records its session. A verdict that cannot be undone (merge a change, run or
 * deny a connector call) confirms in an `AlertDialog` that opens only after the sheet
 * has closed — never two overlays at once (design.md). "Request changes" asks
 * for its text in the sheet. `planReviewVerdict` picks the call.
 *
 * The verdict row is the sheet's pinned footer (`BottomSheetFooter`), so Merge
 * stays on screen over a long change. The scroll content pads by its height.
 */
import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetFooter,
  BottomSheetScrollView,
  type BottomSheetFooterProps,
} from '@gorhom/bottom-sheet';
import type { ReviewItem, ReviewVerdict } from '@kortix/sdk';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fileStatusMeta } from '@/components/diff/PatchDiffView';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import {
  useSheetBackground,
  type SheetRef,
  KortixBottomSheetModal,
} from '@/components/kortix/sheet';
import { SheetBackButton } from '@/components/kortix/sheet-push';
import { useToast } from '@/components/kortix/toast-provider';
import { ReviewFileDiff } from '@/components/review/ReviewFileDiff';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { Icon } from '@/components/ui/icon';
import { ChatsTeardropIcon, GlobeIcon, XCircleIcon } from '@/lib/icons';
import { useChangeRequestDiff, useChangeRequestMergePreview } from '@/lib/projects/hooks';
import type { ChangeRequestDiff } from '@/lib/projects/projects-client';
import { hasMergeConflicts, resolveConflictsPrompt } from '@/lib/review/change-request-recovery';
import { changeRequestWebUrl, reviewDetailRows, splitFilePath } from '@/lib/review/review-detail';
import {
  reviewKindLabel,
  reviewVerdictLabel,
  reviewVerdictToast,
  verdictNeedsConfirm,
  verdictNeedsFeedback,
} from '@/lib/review/review-meta';
import { planReviewVerdict, reviewVerdictsFor } from '@/lib/review/review-verdict';
import { useReviewVerdict } from '@/lib/review/use-review';
import { openLink } from '@/lib/utils/open-link';
import { useSessionPromptRequestStore } from '@/stores/session-prompt-request-store';

interface ReviewDetailSheetProps {
  projectId: string;
  item: ReviewItem | null;
  /** The sheet finished closing. */
  onDismiss?: () => void;
  /**
   * Opens the thread the item came from. Omit it where that thread is already
   * on screen (the thread's own change request cards): the row then hides.
   */
  onOpenSession?: (sessionId: string) => void;
}

/** Files listed before "N more files": the rest are one tap away on the web. */
const MAX_FILE_ROWS = 50;

/** `Button size="lg"` is 44pt. 12pt above the pinned verdict row. */
const PILL = 44;
const FOOTER_TOP = 12;

interface PendingVerdict {
  item: ReviewItem;
  verdict: ReviewVerdict;
}

export const ReviewDetailSheet = React.forwardRef<SheetRef, ReviewDetailSheetProps>(
  ({ projectId, item, onDismiss, onOpenSession }, ref) => {
    const modalRef = React.useRef<BottomSheetModal>(null);
    const { height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const background = useSheetBackground();
    const toast = useToast();
    const verdictMutation = useReviewVerdict(projectId, {
      onSuccess: (input) => {
        haptics.success();
        toast.success(reviewVerdictToast(input.kind, input.verdict, input.number));
      },
      onError: (error) => {
        haptics.warning();
        toast.error((error as Error)?.message ?? 'The review action failed');
      },
    });

    const [feedback, setFeedback] = React.useState('');
    // The file whose diff is pushed over the details (a change's Files row).
    const [openFile, setOpenFile] = React.useState<string | null>(null);
    const [askingFeedback, setAskingFeedback] = React.useState(false);
    // The verdict waiting for its confirm dialog. Set while the sheet is open;
    // the dialog opens from `onDismiss`, after the sheet has closed. A ref, not
    // state: `dismiss()` runs in the same tick as the tap, and gorhom's close
    // animation calls the `onDismiss` it captured then — one that would still
    // read the old, empty state. That stale read dropped every Merge: the
    // confirm never opened and no request went out (Jay, 2026-09-27).
    const queuedRef = React.useRef<PendingVerdict | null>(null);
    const [confirming, setConfirming] = React.useState<PendingVerdict | null>(null);

    // True from `present()` until `onDismiss`. `dismiss()` on a sheet that
    // has already closed is not a no-op in gorhom 5: the modal's `unmount()`
    // reset its status to INITIAL, so a second `dismiss()` marks it
    // DISMISSING and registers an unmount with the provider for a sheet that
    // is not there. The Merge confirm used to do exactly that (the sheet had
    // closed before the dialog opened), and the next row tap often opened
    // nothing (Jay, 2026-09-27). Every close goes through `closeSheet`.
    const presentedRef = React.useRef(false);
    const closeSheet = React.useCallback(() => {
      if (!presentedRef.current) return;
      modalRef.current?.dismiss();
    }, []);
    React.useImperativeHandle(ref, () => ({
      open: () => {
        presentedRef.current = true;
        modalRef.current?.present();
      },
      close: closeSheet,
    }));

    // Optimistic (Jay, 2026-09-27): the sheet and the confirm close at the tap,
    // and the item moves to Done at once (`useReviewItems` reads the pending
    // verdict). A merge still takes seconds on the server; a failure puts the
    // item back and toasts the server's sentence.
    const send = React.useCallback(
      (target: ReviewItem, verdict: ReviewVerdict, text?: string) => {
        const plan = planReviewVerdict(target.id, verdict, text);
        if (!plan) return;
        haptics.tap();
        setConfirming(null);
        closeSheet();
        verdictMutation.mutate({
          itemId: target.id,
          verdict,
          plan,
          kind: target.kind,
          number: target.kind === 'change' ? target.detail.number : undefined,
        });
      },
      [verdictMutation, closeSheet],
    );

    const handleVerdict = React.useCallback(
      (verdict: ReviewVerdict) => {
        if (!item) return;
        haptics.tap();
        if (verdictNeedsFeedback(verdict)) {
          setAskingFeedback(true);
          return;
        }
        if (verdictNeedsConfirm(item.kind, verdict)) {
          queuedRef.current = { item, verdict };
          closeSheet();
          return;
        }
        send(item, verdict);
      },
      [item, send, closeSheet],
    );

    const handleDismiss = React.useCallback(() => {
      presentedRef.current = false;
      setFeedback('');
      setAskingFeedback(false);
      setOpenFile(null);
      const queued = queuedRef.current;
      queuedRef.current = null;
      if (queued) setConfirming(queued);
      onDismiss?.();
    }, [onDismiss]);

    const actionable = item?.status === 'needs_you';
    // A change's diff (its Files, +/− and each file's lines) and, while it is
    // open, its merge preview (conflicts) — both one request each, cached.
    const crId = item?.kind === 'change' ? (item.detail.crId ?? null) : null;
    const diffQuery = useChangeRequestDiff(projectId, crId);
    const previewQuery = useChangeRequestMergePreview(projectId, crId, actionable);
    const detailRows = React.useMemo(
      () => (item ? reviewDetailRows(item, { diff: diffQuery.data, preview: previewQuery.data }) : []),
      [item, diffQuery.data, previewQuery.data],
    );

    const pushFile = React.useCallback((path: string) => {
      haptics.tap();
      setOpenFile(path);
      // A file's diff reads at full height, as in the session actions sheet.
      modalRef.current?.snapToPosition('100%');
    }, []);
    const popFile = React.useCallback(() => {
      haptics.tap();
      setOpenFile(null);
      modalRef.current?.snapToIndex(0);
    }, []);
    // A decision answers from its option rows; its footer holds Dismiss alone.
    const verdicts = React.useMemo<ReviewVerdict[]>(() => {
      if (!item) return [];
      return item.kind === 'decision' ? ['dismiss'] : reviewVerdictsFor(item.kind);
    }, [item]);
    const showFooter = !!item && actionable && !askingFeedback && !openFile;

    // ── Resolve conflicts (in place of Merge while the preview reports any) ──
    const conflicted = item?.kind === 'change' && hasMergeConflicts(item.status, previewQuery.data);
    const originSessionId = item?.sessionId ?? null;
    const resolveConflicts = React.useCallback(() => {
      if (!item || item.kind !== 'change' || !originSessionId) return;
      haptics.tap();
      // The session that opened the change: it takes the request when it
      // mounts (keyed by the project session id) and sends it, or queues it
      // while its agent works. Inside that session (its change request
      // cards pass no `onOpenSession`) the open thread takes it at once.
      useSessionPromptRequestStore.getState().requestSend(
        originSessionId,
        resolveConflictsPrompt({
          number: item.detail.number ?? 0,
          conflictCount: previewQuery.data?.conflicts.length ?? 0,
        }),
      );
      closeSheet();
      onOpenSession?.(originSessionId);
    }, [item, originSessionId, previewQuery.data, onOpenSession, closeSheet]);
    const footerPadding = Math.max(insets.bottom, 16) + 8;
    const footerHeight = showFooter
      ? FOOTER_TOP + (verdicts.length > 2 ? verdicts.length * (PILL + 12) - 12 : PILL) + footerPadding
      : 0;

    const renderFooter = React.useCallback(
      (props: BottomSheetFooterProps) =>
        showFooter && item ? (
          <BottomSheetFooter {...props}>
            {/* Two verdicts share one row, 50/50, the primary on the right
                (Request changes · Merge). Three stack, primary first. */}
            <View
              className={verdicts.length > 2 ? 'gap-3 px-4' : 'flex-row-reverse gap-3 px-4'}
              style={{ backgroundColor: background, paddingTop: FOOTER_TOP, paddingBottom: footerPadding }}>
              {verdicts.map((verdict, index) => {
                // A conflicted change cannot merge: its primary resolves instead.
                const resolves = conflicted && verdict === 'approve';
                return (
                  <Button
                    key={verdict}
                    variant={
                      verdict === 'dismiss'
                        ? 'ghost'
                        : index === 0
                          ? 'default'
                          : 'secondary'
                    }
                    size="lg"
                    className={verdicts.length > 2 ? 'rounded-full' : 'flex-1 rounded-full'}
                    disabled={resolves && !originSessionId}
                    onPress={() => (resolves ? resolveConflicts() : handleVerdict(verdict))}>
                    <Text numberOfLines={1}>
                      {resolves ? 'Resolve conflicts' : reviewVerdictLabel(item.kind, verdict)}
                    </Text>
                  </Button>
                );
              })}
            </View>
          </BottomSheetFooter>
        ) : null,
      [showFooter, item, verdicts, background, footerPadding, handleVerdict, conflicted, originSessionId, resolveConflicts],
    );

    return (
      <>
        <KortixBottomSheetModal
          ref={modalRef}
          title={openFile ? splitFilePath(openFile).name : item ? reviewKindLabel(item.kind) : undefined}
          titleLeading={openFile ? <SheetBackButton onPress={popFile} /> : undefined}
          enableDynamicSizing
          maxDynamicContentSize={Math.floor(height * 0.9)}
          enablePanDownToClose
          onDismiss={handleDismiss}
          footerComponent={renderFooter}
          keyboardBehavior="interactive"
          keyboardBlurBehavior="restore">
          {openFile ? (
            <ReviewFileDiff
              patch={diffQuery.data?.patch}
              path={openFile}
              isLoading={diffQuery.isLoading}
              isError={diffQuery.isError}
              isDark={isDark}
              bottomInset={footerPadding}
            />
          ) : (
          <BottomSheetScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 4,
              // Clears the pinned verdict row, or the home indicator without one.
              paddingBottom: footerHeight || footerPadding,
              gap: 16,
            }}>
            {item ? (
              <>
                {/* The sheet's title row names the kind; this is the item. */}
                <Text variant="large" className="px-2">
                  {item.title}
                </Text>

                {/* Aligned label · value rows: agent, risk, or a change's
                    number, branch, size and merge state. */}
                {detailRows.length > 0 ? (
                  <SettingsGroup title="Details">
                    {detailRows.map((row) => (
                      <SettingsRow
                        key={row.label}
                        label={row.label}
                        value={row.value}
                        // A warning (conflicts) colours its value, not the label.
                        valueDestructive={row.warn}
                        right={null}
                        dense
                      />
                    ))}
                  </SettingsGroup>
                ) : null}

                <ReviewBody
                  projectId={projectId}
                  item={item}
                  onAnswer={send}
                  actionable={actionable}
                  diff={diffQuery.data}
                  diffLoading={diffQuery.isLoading}
                  diffFailed={diffQuery.isError}
                  onRetryDiff={() => void diffQuery.refetch()}
                  onOpenFile={pushFile}
                  isDark={isDark}
                />

                {/* Where else the item lives: its session, and (a change) the web. */}
                {(item.sessionId && onOpenSession) || item.kind === 'change' ? (
                  <SettingsGroup>
                    {item.sessionId && onOpenSession ? (
                      <SettingsRow
                        icon={ChatsTeardropIcon}
                        label="Open session"
                        onPress={() => {
                          const sessionId = item.sessionId!;
                          closeSheet();
                          onOpenSession(sessionId);
                        }}
                      />
                    ) : null}
                    {item.kind === 'change' ? (
                      <SettingsRow
                        icon={GlobeIcon}
                        label="Open on web"
                        external
                        onPress={() => void openLink(changeRequestWebUrl(projectId, item)).catch(() => {})}
                      />
                    ) : null}
                  </SettingsGroup>
                ) : null}

                {actionable && askingFeedback ? (
                  <View className="gap-3">
                    <SheetTextInput
                      value={feedback}
                      onChangeText={setFeedback}
                      placeholder="What should change?"
                      accessibilityLabel="Requested changes"
                      autoFocus
                      multiline
                    />
                    <View className="flex-row gap-3">
                      <Button
                        variant="secondary"
                        size="lg"
                        className="flex-1 rounded-full"
                        onPress={() => setAskingFeedback(false)}>
                        <Text>Cancel</Text>
                      </Button>
                      <Button
                        size="lg"
                        className="flex-1 rounded-full"
                        disabled={!feedback.trim()}
                        onPress={() => send(item, 'changes', feedback.trim())}>
                        <Text>Send</Text>
                      </Button>
                    </View>
                  </View>
                ) : null}

                {/* Last in the sheet, alone and destructive (Jay, 2026-09-27):
                    close the change request without merging. The `dismiss`
                    verdict — it confirms after the sheet closes, then closes
                    the change request (`planReviewVerdict` → `close`). */}
                {item.kind === 'change' && actionable && !askingFeedback ? (
                  <SettingsGroup>
                    <SettingsRow
                      icon={XCircleIcon}
                      label="Close change request"
                      destructive
                      right={null}
                      onPress={() => handleVerdict('dismiss')}
                    />
                  </SettingsGroup>
                ) : null}
              </>
            ) : null}
          </BottomSheetScrollView>
          )}
        </KortixBottomSheetModal>

        <AlertDialog
          open={!!confirming}
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}>
          <AlertDialogContent className="rounded-3xl">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirming ? reviewVerdictLabel(confirming.item.kind, confirming.verdict) : ''}
              </AlertDialogTitle>
              <AlertDialogDescription>{confirming?.item.title ?? ''}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button variant="secondary" size="lg" className="rounded-full">
                  <Text>Cancel</Text>
                </Button>
              </AlertDialogCancel>
              <Button
                variant={confirming?.verdict === 'approve' ? 'default' : 'destructive'}
                size="lg"
                className="rounded-full"
                onPress={() => confirming && send(confirming.item, confirming.verdict)}>
                <Text>{confirming ? reviewVerdictLabel(confirming.item.kind, confirming.verdict) : ''}</Text>
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  },
);
ReviewDetailSheet.displayName = 'ReviewDetailSheet';

// ─── Bodies ──────────────────────────────────────────────────────────────────

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <View className="gap-2 px-2">
      {title ? <Text variant="muted">{title}</Text> : null}
      {children}
    </View>
  );
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <View className="gap-1">
      {lines.map((line, index) => (
        <Text key={`${index}-${line}`}>{line}</Text>
      ))}
    </View>
  );
}

interface ChangeFilesProps {
  diff: ChangeRequestDiff | undefined;
  diffLoading: boolean;
  diffFailed: boolean;
  onRetryDiff: () => void;
  onOpenFile: (path: string) => void;
  isDark: boolean;
}

function ReviewBody({
  projectId,
  item,
  onAnswer,
  actionable,
  ...files
}: {
  projectId: string;
  item: ReviewItem;
  onAnswer: (item: ReviewItem, verdict: ReviewVerdict, text?: string) => void;
  actionable: boolean;
} & ChangeFilesProps) {
  switch (item.kind) {
    case 'change':
      return <ChangeBody projectId={projectId} item={item} {...files} />;
    case 'approval':
      return (
        <>
          {item.detail.actions.map((action) => (
            // One action: the sheet title already names it.
            <Section key={action.id} title={action.title === item.title ? undefined : action.title}>
              <Text variant="muted">{action.consequence}</Text>
              {action.previewAuthorized === false ? (
                <Text variant="muted">You do not have access to this call's arguments.</Text>
              ) : action.argsPreview.length === 0 ? (
                <Text variant="muted">No arguments.</Text>
              ) : (
                <View className="gap-2">
                  {action.argsPreview.map((arg) => (
                    <View key={arg.key} className="gap-0.5">
                      <Text variant="small">{arg.key}</Text>
                      <Text variant="code" selectable>
                        {arg.value}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </Section>
          ))}
        </>
      );
    case 'decision':
      return (
        <>
          {/* The sheet title is the question when the agent sent no separate one. */}
          {item.detail.question !== item.title || item.detail.context ? (
            <Section>
              {item.detail.question !== item.title ? <Text>{item.detail.question}</Text> : null}
              {item.detail.context ? <Text variant="muted">{item.detail.context}</Text> : null}
            </Section>
          ) : null}
          <SettingsGroup>
            {item.detail.options.map((option) => (
              <SettingsRow
                key={option.id}
                label={option.recommended ? `${option.label} (recommended)` : option.label}
                multiline
                right={null}
                onPress={
                  actionable ? () => onAnswer(item, 'answer', option.label) : undefined
                }
              />
            ))}
          </SettingsGroup>
        </>
      );
    case 'output':
      return (
        <>
          <Section title={item.detail.artifactLabel}>
            <Text>{item.detail.note}</Text>
            {item.detail.preview ? (
              <Text variant="code" selectable>
                {item.detail.preview}
              </Text>
            ) : null}
          </Section>
          {item.detail.previewUrl ? (
            <SettingsGroup>
              <SettingsRow
                label="Open preview"
                external
                onPress={() => void openLink(item.detail.previewUrl!).catch(() => {})}
              />
            </SettingsGroup>
          ) : null}
        </>
      );
    case 'batch':
      return (
        <>
          <Section title="Summary">
            <Text>{item.detail.note}</Text>
          </Section>
          <SettingsGroup>
            {item.detail.children.map((child) => (
              <SettingsRow
                key={child.id}
                label={child.title}
                multiline
                value={child.status === 'done' ? 'Done' : 'Needs review'}
              />
            ))}
          </SettingsGroup>
        </>
      );
  }
}

function ChangeBody({
  projectId,
  item,
  diff,
  diffLoading,
  diffFailed,
  onRetryDiff,
  onOpenFile,
  isDark,
}: {
  projectId: string;
  item: Extract<ReviewItem, { kind: 'change' }>;
} & ChangeFilesProps) {
  const { detail } = item;
  const files = diff?.files ?? [];
  const shown = files.slice(0, MAX_FILE_ROWS);
  return (
    <>
      {detail.whatChanged.length > 0 ? (
        <Section title="What changed">
          <Lines lines={detail.whatChanged} />
        </Section>
      ) : null}
      {detail.impact ? (
        <Section title="Impact">
          <Text>{detail.impact}</Text>
        </Section>
      ) : null}
      {detail.conflicts && detail.conflicts.length > 0 ? (
        <Section title="Conflicts">
          <Lines lines={detail.conflicts} />
        </Section>
      ) : null}
      {detail.verification.length > 0 ? (
        <Section title="Checks">
          <Lines lines={detail.verification.map((check) => check.label)} />
        </Section>
      ) : null}
      {detail.requestedChanges && detail.requestedChanges.length > 0 ? (
        <Section title="Requested changes">
          <Lines lines={detail.requestedChanges.map((change) => change.text)} />
        </Section>
      ) : null}
      {detail.crId ? (
        // The changed files, no diff drawn: a row pushes that file's diff.
        diffLoading ? (
          <View className="gap-2">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </View>
        ) : diffFailed ? (
          <SettingsGroup title="Files">
            <SettingsRow label="The changes did not load" value="Retry" right={null} onPress={onRetryDiff} />
          </SettingsGroup>
        ) : files.length > 0 ? (
          <SettingsGroup title="Files">
            {shown.map((file) => {
              const { name, dir } = splitFilePath(file.path);
              const meta = fileStatusMeta(file.status, isDark);
              return (
                <SettingsRow
                  key={file.path}
                  leading={<Icon as={meta.icon} size={18} color={meta.color} />}
                  label={name}
                  description={dir || undefined}
                  value={`+${file.additions} −${file.deletions}`}
                  dense
                  accessibilityLabel={`${file.path}, ${file.additions} added, ${file.deletions} removed`}
                  onPress={() => onOpenFile(file.path)}
                />
              );
            })}
            {files.length > shown.length ? (
              <SettingsRow label={`${files.length - shown.length} more files on the web`} right={null} dense />
            ) : null}
          </SettingsGroup>
        ) : null
      ) : null}
    </>
  );
}
