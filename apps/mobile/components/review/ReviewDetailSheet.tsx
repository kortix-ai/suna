/**
 * ReviewDetailSheet — one review item, with the verdicts its kind offers.
 *
 * One sheet, one body per kind:
 * - change: what changed, the agent's checks, the unified diff, merge conflicts.
 * - approval: each connector call with its arguments. Arguments the viewer may
 *   not see are named as hidden, never shown as empty.
 * - decision: the question and its options. Choosing one answers.
 * - output: the agent's note, a text preview, a link to the live preview.
 * - batch: the finished items, one sign-off.
 *
 * A change offers Merge and Request changes, side by side; it has no Close
 * (Jay, 2026-09-21). A verdict that cannot be undone (merge a change, run or
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

import { PatchDiffView } from '@/components/diff/PatchDiffView';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import {
  useSheetBackground,
  type SheetRef,
  KortixBottomSheetModal,
} from '@/components/kortix/sheet';
import { useToast } from '@/components/kortix/toast-provider';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { ChatsTeardropIcon } from '@/lib/icons';
import { useChangeRequestDiff } from '@/lib/projects/hooks';
import {
  reviewKindLabel,
  reviewRiskLabel,
  reviewVerdictLabel,
  verdictNeedsConfirm,
  verdictNeedsFeedback,
} from '@/lib/review/review-meta';
import { planReviewVerdict, reviewVerdictsFor } from '@/lib/review/review-verdict';
import { useReviewVerdict } from '@/lib/review/use-review';
import { openLink } from '@/lib/utils/open-link';

interface ReviewDetailSheetProps {
  projectId: string;
  item: ReviewItem | null;
  onDismiss: () => void;
  /** Opens the thread the item came from. */
  onOpenSession: (sessionId: string) => void;
}

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
    const verdictMutation = useReviewVerdict(projectId);

    const [feedback, setFeedback] = React.useState('');
    const [askingFeedback, setAskingFeedback] = React.useState(false);
    // The verdict waiting for its confirm dialog. Set while the sheet is open;
    // the dialog opens from `onDismiss`, after the sheet has closed.
    const [queued, setQueued] = React.useState<PendingVerdict | null>(null);
    const [confirming, setConfirming] = React.useState<PendingVerdict | null>(null);

    React.useImperativeHandle(ref, () => ({
      open: () => modalRef.current?.present(),
      close: () => modalRef.current?.dismiss(),
    }));

    const send = React.useCallback(
      (target: ReviewItem, verdict: ReviewVerdict, text?: string) => {
        const plan = planReviewVerdict(target.id, verdict, text);
        if (!plan) return;
        verdictMutation.mutate(plan, {
          onSuccess: () => {
            haptics.tap();
            setConfirming(null);
            modalRef.current?.dismiss();
          },
          onError: (error) => {
            setConfirming(null);
            toast.error((error as Error)?.message ?? 'The review action failed');
          },
        });
      },
      [verdictMutation, toast],
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
          setQueued({ item, verdict });
          modalRef.current?.dismiss();
          return;
        }
        send(item, verdict);
      },
      [item, send],
    );

    const handleDismiss = React.useCallback(() => {
      setFeedback('');
      setAskingFeedback(false);
      if (queued) {
        setConfirming(queued);
        setQueued(null);
      }
      onDismiss();
    }, [queued, onDismiss]);

    const actionable = item?.status === 'needs_you';
    const risk = item ? reviewRiskLabel(item.risk) : null;
    // A decision answers from its option rows; its footer holds Dismiss alone.
    const verdicts = React.useMemo<ReviewVerdict[]>(() => {
      if (!item) return [];
      return item.kind === 'decision' ? ['dismiss'] : reviewVerdictsFor(item.kind);
    }, [item]);
    const showFooter = !!item && actionable && !askingFeedback;
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
              {verdicts.map((verdict, index) => (
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
                  disabled={verdictMutation.isPending}
                  onPress={() => handleVerdict(verdict)}>
                  <Text numberOfLines={1}>{reviewVerdictLabel(item.kind, verdict)}</Text>
                </Button>
              ))}
            </View>
          </BottomSheetFooter>
        ) : null,
      [showFooter, item, verdicts, background, footerPadding, verdictMutation.isPending, handleVerdict],
    );

    return (
      <>
        <KortixBottomSheetModal
          ref={modalRef}
          title={item ? reviewKindLabel(item.kind) : undefined}
          enableDynamicSizing
          maxDynamicContentSize={Math.floor(height * 0.9)}
          enablePanDownToClose
          onDismiss={handleDismiss}
          footerComponent={renderFooter}
          keyboardBehavior="interactive"
          keyboardBlurBehavior="restore">
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
                <View className="gap-2 px-2">
                  {/* The sheet's title row names the kind; this is the item. */}
                  <Text variant="large">{item.title}</Text>
                  <View className="flex-row flex-wrap items-center gap-2">
                    {risk ? (
                      <Badge variant={item.risk === 'high' ? 'destructive' : 'outline'}>
                        <Text>{risk}</Text>
                      </Badge>
                    ) : null}
                    <Text variant="muted" numberOfLines={1} className="shrink">
                      {item.agent}
                    </Text>
                  </View>
                </View>

                <ReviewBody projectId={projectId} item={item} isDark={isDark} onAnswer={send} answering={verdictMutation.isPending} actionable={actionable} />

                {item.sessionId ? (
                  <SettingsGroup>
                    <SettingsRow
                      icon={ChatsTeardropIcon}
                      label="Open session"
                      onPress={() => {
                        const sessionId = item.sessionId!;
                        modalRef.current?.dismiss();
                        onOpenSession(sessionId);
                      }}
                    />
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
                        disabled={!feedback.trim() || verdictMutation.isPending}
                        onPress={() => send(item, 'changes', feedback.trim())}>
                        <Text>{verdictMutation.isPending ? 'Sending…' : 'Send'}</Text>
                      </Button>
                    </View>
                  </View>
                ) : null}
              </>
            ) : null}
          </BottomSheetScrollView>
        </KortixBottomSheetModal>

        <AlertDialog
          open={!!confirming}
          onOpenChange={(open) => {
            if (!open && !verdictMutation.isPending) setConfirming(null);
          }}>
          <AlertDialogContent className="rounded-3xl">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirming ? reviewVerdictLabel(confirming.item.kind, confirming.verdict) : ''}
              </AlertDialogTitle>
              <AlertDialogDescription>{confirming?.item.title ?? ''}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel asChild disabled={verdictMutation.isPending}>
                <Button variant="secondary" size="lg" className="rounded-full">
                  <Text>Cancel</Text>
                </Button>
              </AlertDialogCancel>
              <Button
                variant={confirming?.verdict === 'approve' ? 'default' : 'destructive'}
                size="lg"
                className="rounded-full"
                disabled={verdictMutation.isPending}
                onPress={() => confirming && send(confirming.item, confirming.verdict)}>
                <Text>
                  {verdictMutation.isPending
                    ? 'Working…'
                    : confirming
                      ? reviewVerdictLabel(confirming.item.kind, confirming.verdict)
                      : ''}
                </Text>
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

function ReviewBody({
  projectId,
  item,
  isDark,
  onAnswer,
  answering,
  actionable,
}: {
  projectId: string;
  item: ReviewItem;
  isDark: boolean;
  onAnswer: (item: ReviewItem, verdict: ReviewVerdict, text?: string) => void;
  answering: boolean;
  actionable: boolean;
}) {
  switch (item.kind) {
    case 'change':
      return <ChangeBody projectId={projectId} item={item} isDark={isDark} />;
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
                  actionable && !answering ? () => onAnswer(item, 'answer', option.label) : undefined
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
  isDark,
}: {
  projectId: string;
  item: Extract<ReviewItem, { kind: 'change' }>;
  isDark: boolean;
}) {
  const { detail } = item;
  const diffQuery = useChangeRequestDiff(projectId, detail.crId ?? null);
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
        <Section title="Diff">
          {diffQuery.isLoading ? (
            <Skeleton className="h-24 w-full rounded-xl" />
          ) : diffQuery.isError ? (
            <Text variant="muted">The diff did not load.</Text>
          ) : (
            <PatchDiffView patch={diffQuery.data?.patch ?? ''} isDark={isDark} />
          )}
        </Section>
      ) : null}
    </>
  );
}
