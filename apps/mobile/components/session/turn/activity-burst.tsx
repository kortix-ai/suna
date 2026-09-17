/**
 * One burst — a maximal run of non-text parts (`segmentTurn` kind `burst`).
 *
 * Mirrors apps/web `turn/activity-burst.tsx`:
 * - summary line: `text-sm text-muted-foreground/70`, `gap-2`, the SDK's
 *   `burstSummaryLabel` ("Working · N steps" as a muted shimmer, "Completed N
 *   steps", "Completed X of N steps · F failed", "N steps failed"), trailing
 *   caret `size-3.5 text-muted-foreground/40`;
 * - body `mt-3`: a `ChainOfThought` (`space-y-3`) of thought rows, same-family
 *   group rows, file-chip rows, and tool rows; each step draws its rail only
 *   while it holds open content;
 * - opens itself while running (not under `density="minimal"`), collapses
 *   when it settles, and the user's toggle wins permanently;
 * - a burst of ONE call is bare: no summary line, no gap, permanently open;
 * - a burst that merges to nothing (plumbing only) renders nothing.
 *
 * Expand state lives in `lib/session/disclosure-store.ts`, keyed by the first
 * part id, so it survives FlatList recycling.
 */

import { memo, useCallback, useMemo } from 'react';
import { Pressable, View } from 'react-native';
import type { Part, Step } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import {
  burstView,
  isFileChipPart,
  isFileChipRun,
  resolveDisclosureOpen,
  samePartsList,
} from '@/lib/session/activity';
import { disclosureKey, useDisclosureChoice, useDisclosureStore } from '@/lib/session/disclosure-store';
import {
  ChainOfThought,
  ChainOfThoughtStep,
  DisclosureCaret,
  DisclosureContent,
  useReportOpen,
} from '@/components/session/chain-of-thought';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';
import type { PermissionReply } from '@/components/session/tool/tool-part-renderer';
import { ActivityFileChipStep } from './activity-file-chips';
import {
  ActivityContext,
  ActivityStep,
  StepTrigger,
  iconFor,
  type ActivityContextValue,
} from './activity-step';
import { ThoughtStep } from './thought-step';

// ─── Same-family group ───────────────────────────────────────────────────────

function ActivityGroupStepImpl({ step, running }: { step: Step; running: boolean }) {
  const palette = useTurnPalette();
  const key = disclosureKey('group', step.parts[0]?.id ?? step.id);
  const choice = useDisclosureChoice(key);
  const open = resolveDisclosureOpen({ userChoice: choice, auto: false });
  const Icon = iconFor(step.parts[0] as Part);

  useReportOpen(open);

  const toggle = useCallback(() => {
    useDisclosureStore.getState().setChoice(key, !open);
  }, [key, open]);

  return (
    <View>
      <StepTrigger
        open={open}
        onToggle={toggle}
        leading={<Icon size={TURN_SPACE.icon} color={palette.mutedForeground} />}
        label={step.label}
        running={step.status === 'running'}
      />
      <DisclosureContent open={open}>
        <View style={{ marginTop: TURN_SPACE.gap3, paddingLeft: TURN_SPACE.nestIndent }}>
          <ChainOfThought>
            {step.parts.map((part) => (
              <ChainOfThoughtStep key={part.id}>
                <ActivityStep part={part as Part} running={running} />
              </ChainOfThoughtStep>
            ))}
          </ChainOfThought>
        </View>
      </DisclosureContent>
    </View>
  );
}

/** `step` is rebuilt per merge; compare its content (web `sameActivityGroupStepProps`). */
export const ActivityGroupStep = memo(
  ActivityGroupStepImpl,
  (a, b) =>
    a.running === b.running &&
    a.step.status === b.step.status &&
    a.step.label === b.step.label &&
    samePartsList(a.step.parts, b.step.parts),
);
ActivityGroupStep.displayName = 'ActivityGroupStep';

// ─── Burst ───────────────────────────────────────────────────────────────────

export interface ActivityBurstProps {
  segment: { kind: 'burst'; parts: Part[] };
  /** The owning turn is still working (web `working`). */
  turnLive: boolean;
  /** Last segment in the turn — stays open across SSE gaps between tool calls. */
  isTrailing?: boolean;
  /** `minimal`: nothing opens itself; the live view is the summary line. */
  density?: 'normal' | 'minimal';
  sessionId?: string;
  onOpenFile?: (path: string) => void;
  toDisplayPath?: (path: string) => string;
  onPermissionReply?: (requestId: string, reply: PermissionReply) => void;
}

function ActivityBurstImpl({
  segment,
  turnLive,
  isTrailing = false,
  density = 'normal',
  sessionId,
  onOpenFile,
  toDisplayPath,
  onPermissionReply,
}: ActivityBurstProps) {
  const palette = useTurnPalette();
  const { parts } = segment;
  const view = useMemo(() => burstView(parts, turnLive, isTrailing), [parts, turnLive, isTrailing]);
  const autoExpand = density !== 'minimal';
  const key = disclosureKey('burst', parts[0]?.id ?? '');
  const choice = useDisclosureChoice(key);
  const open = view.bare || resolveDisclosureOpen({ userChoice: choice, auto: autoExpand && view.running });

  const context = useMemo<ActivityContextValue>(
    () => ({ sessionId, turnLive, onOpenFile, toDisplayPath, onPermissionReply }),
    [sessionId, turnLive, onOpenFile, toDisplayPath, onPermissionReply],
  );

  const toggle = useCallback(() => {
    useDisclosureStore.getState().setChoice(key, !open);
  }, [key, open]);

  if (view.hidden) return null;

  const { running, bare } = view;

  const chain = (
    <ChainOfThought>
      {view.steps.map((step) => {
        if (step.kind === 'thought') {
          return (
            <ChainOfThoughtStep key={step.key}>
              <ThoughtStep
                id={step.key}
                texts={step.texts}
                running={running && step.running}
                durationMs={step.durationMs}
                bare={bare}
                autoOpen={autoExpand}
              />
            </ChainOfThoughtStep>
          );
        }
        let body;
        if (step.kind === 'group') {
          body = isFileChipRun(step.step.parts as Part[]) ? (
            <ActivityFileChipStep parts={step.step.parts as Part[]} running={running} />
          ) : (
            <ActivityGroupStep step={step.step} running={running} />
          );
        } else if (isFileChipPart(step.part)) {
          body = <ActivityFileChipStep parts={[step.part]} bare={bare} running={running} />;
        } else {
          body = <ActivityStep part={step.part} bare={bare} running={running} />;
        }
        return <ChainOfThoughtStep key={step.key}>{body}</ChainOfThoughtStep>;
      })}
    </ChainOfThought>
  );

  return (
    <ActivityContext.Provider value={context}>
      <View>
        {bare ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={toggle}
            style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}
          >
            {running ? (
              <TextShimmer variant="muted" tone="muted" style={[TURN_TYPE.sm, TABULAR]} numberOfLines={1}>
                {view.title}
              </TextShimmer>
            ) : (
              <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.sm, TABULAR, { flexShrink: 1, color: palette.muted70 }]}>
                {view.title}
              </Text>
            )}
            <DisclosureCaret open={open} color={palette.muted40} />
          </Pressable>
        )}
        {bare ? (
          chain
        ) : (
          <DisclosureContent open={open}>
            <View style={{ marginTop: TURN_SPACE.gap3 }}>{chain}</View>
          </DisclosureContent>
        )}
      </View>
    </ActivityContext.Provider>
  );
}

const TABULAR = { fontVariant: ['tabular-nums' as const] };

/** `segment.parts` is a fresh array per frame while a turn streams — compare element-wise. */
export const ActivityBurst = memo(
  ActivityBurstImpl,
  (a, b) =>
    a.turnLive === b.turnLive &&
    a.isTrailing === b.isTrailing &&
    a.density === b.density &&
    a.sessionId === b.sessionId &&
    a.onOpenFile === b.onOpenFile &&
    a.toDisplayPath === b.toDisplayPath &&
    a.onPermissionReply === b.onPermissionReply &&
    samePartsList(a.segment.parts, b.segment.parts),
);
ActivityBurst.displayName = 'ActivityBurst';
