/**
 * `workflow` — the run card. Port of apps/web `tool/tools/workflow-tool.tsx` +
 * `workflow-run-card.tsx` (Paper C19, F1–F5). One bordered card, never a fold:
 *
 *   header  28pt progress ring · title · one-line subtitle · "Result" toggle
 *   rows    grouped by phase, a dashed rule between phases; status mark · name ·
 *           state · time; a failed row adds its reason in red
 *   pending a phase not started is one muted row: "Waits for N more", else "Starts after …"
 *
 * A run that ended in its own runner session is the header alone. A background
 * run whose run document is not here yet is one line: ring · title · how it
 * ended · Open run. A tap on an agent row opens that agent's session.
 *
 * Mobile reads the run from the call's metadata only; web also reads a
 * background run live from its runner's run list.
 */

import { useContext, useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { parseWorkflowResult, parseWorkflowRun, type WorkflowRun } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { CaretRightIcon, TreeStructureIcon } from '@/lib/icons';
import { Icon } from '@/components/ui/icon';
import { useProjectSession } from '@/lib/projects/hooks';
import { agentSessionDisplay } from '@/lib/session/tools/agents-task';
import {
  RUNNER_OUTCOME_LABEL,
  runnerOutcome,
  workflowCardModel,
  type WorkflowAgentRowModel,
  type WorkflowGroupModel,
} from '@/lib/session/tools/agents-workflow';
import { webSpace } from '@/lib/session/user-message';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import { ConnectorHandoffContext } from '../shared/connector-handoff-context';
import { BasicTool, partError, partMetadata, partOutput, partStatus, ToolOutputFallback, useToolNavigation } from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { AgentCard, RunProgressRing } from '../shared/agent-surface';
import { AgentFailure } from '../shared/message-row';
import { FONT_MEDIUM, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

/** The current time, every second while `active`: a live run's elapsed labels tick. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function WorkflowTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const status = partStatus(call);
  const settled = status === 'completed' || status === 'error';
  const run = useMemo(() => parseWorkflowRun(partMetadata(call)), [call]);
  const live = !!run && run.status === 'running' && !settled && !run.background;
  const now = useNow(live);

  if (!run) {
    // Before the first run document, or a call with none: the plain row and its output.
    const output = partOutput(call);
    return (
      <BasicTool
        icon={TreeStructureIcon}
        trigger={{ title: settled ? 'Workflow' : 'Starting the workflow…', subtitle: '', args: [] }}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
      >
        {output ? <ToolOutputFallback output={output} toolName="workflow" /> : null}
      </BasicTool>
    );
  }
  // A run that ended in an error, or a call that failed (whatever its last run document said),
  // says so under the card; its raw text folds behind Details (web `WorkflowTool`).
  const runError = run.error ?? (status === 'error' ? partError(call) : undefined);
  const failure =
    runError && (run.status !== 'running' || status === 'error') ? (
      <View style={{ marginTop: webSpace(2), paddingHorizontal: webSpace(4) }}>
        <AgentFailure sentence="The workflow stopped before it finished." raw={runError} toolName={call.name} />
      </View>
    ) : null;
  if (run.background && run.agents.length === 0) {
    return (
      <>
        <WorkflowRunLink run={run} />
        {failure}
      </>
    );
  }
  const result = status === 'completed' && run.status === 'done' ? parseWorkflowResult(partOutput(call)) : null;
  return (
    <>
      <WorkflowRunCard run={run} live={live} now={now} settled={settled} result={result} />
      {failure}
    </>
  );
}

/** A background run whose rows live in its runner session: one line, how it ended, Open run. */
function WorkflowRunLink({ run }: { run: WorkflowRun }) {
  const palette = useTurnPalette();
  const { enabled, openSession } = useToolNavigation();
  const handoff = useContext(ConnectorHandoffContext);
  const runner = run.background?.sessionId ?? null;
  const row = useProjectSession(handoff?.projectId ?? null, runner).data;
  const ended = runnerOutcome(row ? agentSessionDisplay(row) : null);
  const title = run.title || run.name || 'Workflow';
  return (
    <AgentCard
      testID="workflow-run-link"
      label="Open the run's session"
      onPress={enabled && runner ? () => openSession(runner) : undefined}
      style={{ marginTop: webSpace(1.5) }}
    >
      {ended ? (
        <RunProgressRing
          done={ended === 'done' ? 1 : 0}
          failed={ended === 'failed' ? 1 : 0}
          total={1}
          ended={ended === 'failed' ? null : ended}
        />
      ) : (
        <Icon as={TreeStructureIcon} size={16} className="text-muted-foreground" />
      )}
      <Text numberOfLines={1} style={[TURN_TYPE.sm, { flexShrink: 1, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
        {title}
      </Text>
      {ended ? (
        <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
          {RUNNER_OUTCOME_LABEL[ended]}
        </Text>
      ) : null}
      <View style={{ flex: 1 }} />
      <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>Open run</Text>
    </AgentCard>
  );
}

function WorkflowRunCard({
  run,
  live,
  now,
  settled,
  result,
}: {
  run: WorkflowRun;
  live: boolean;
  now: number;
  settled: boolean;
  result: ReturnType<typeof parseWorkflowResult>;
}) {
  const palette = useTurnPalette();
  const { enabled, openSession } = useToolNavigation();
  const [showResult, setShowResult] = useState(false);
  const model = useMemo(() => workflowCardModel(run, { live, now, settled }), [run, live, now, settled]);
  const runner = run.background?.sessionId;
  const open = (sessionId: string | null) => (enabled && sessionId ? () => openSession(sessionId) : undefined);

  return (
    <AgentCard testID="workflow-card" style={{ marginTop: webSpace(1.5) }}>
      <View
        style={[
          // One left edge for the header and the rows (web px-4); the ring sits in the rows' 16pt glyph lane.
          { flexDirection: 'row', alignItems: 'flex-start', gap: webSpace(2.5), paddingHorizontal: webSpace(4), paddingVertical: webSpace(3) },
          { borderBottomWidth: 1, borderBottomColor: palette.border },
        ]}
      >
        {model.ring.total > 0 ? (
          <View style={{ height: 20, justifyContent: 'center' }}>
            <RunProgressRing size={16} done={model.ring.done} failed={model.ring.failed} total={model.ring.total} ended={model.ring.ended} />
          </View>
        ) : (
          <Icon as={TreeStructureIcon} size={16} className="text-muted-foreground" />
        )}
        <View style={{ flex: 1, minWidth: 0, gap: webSpace(0.5) }}>
          <Text numberOfLines={1} style={[TURN_TYPE.sm, { fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
            {model.title}
          </Text>
          {model.subtitle ? (
            <Text numberOfLines={1} style={[TURN_TYPE.xs, { color: palette.mutedForeground, fontVariant: ['tabular-nums'] }]}>
              {model.subtitle}
            </Text>
          ) : null}
        </View>
        {result ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showResult }}
            onPress={() => setShowResult((value) => !value)}
            hitSlop={webSpace(3)}
          >
            <Text style={[TURN_TYPE.xs, { color: palette.foreground }]}>Result</Text>
          </Pressable>
        ) : null}
        {runner && model.headerOnly ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Open the run's session" onPress={open(runner)} hitSlop={webSpace(3)}>
            <Text style={[TURN_TYPE.xs, { color: palette.foreground }]}>Open run</Text>
          </Pressable>
        ) : null}
      </View>
      {result && showResult ? (
        <View style={{ paddingHorizontal: webSpace(4), paddingVertical: webSpace(3), borderBottomWidth: 1, borderBottomColor: palette.border }}>
          <OutputBlock text={result.text} markdown={result.kind === 'markdown'} />
        </View>
      ) : null}
      {/* Never a fold (web `WorkflowRunCard`): running or ended, the rows are the record of who did what. */}
      <View style={{ padding: webSpace(1.5) }}>
        {model.groups.map((group) => (
          <GroupView key={group.kind === 'pending' ? `pending:${group.title}` : `phase:${group.title ?? ''}`} group={group} open={open} />
        ))}
      </View>
    </AgentCard>
  );
}

/** The ring of a phase row sits in this lane; the trunk of its open agents hangs from the ring's centre. */
const PHASE_PAD = webSpace(2.5);
const RING = 16;

function GroupView({ group, open }: { group: WorkflowGroupModel; open: (sessionId: string | null) => (() => void) | undefined }) {
  if (group.kind === 'pending') {
    // One phrase for why it has not started: the agents it waits on, else the phase before it.
    return <PhaseHeader title={group.title} ring={{ done: 0, failed: 0, total: 0, ended: null }} meta={group.waits || (group.after ? `Starts after ${group.after}` : null)} muted />;
  }
  if (!group.title) {
    return (
      <View>
        {group.rows.map((row) => (
          <AgentRowView key={row.id} row={row} onPress={open(row.sessionId)} />
        ))}
      </View>
    );
  }
  return <PhaseView group={group} open={open} />;
}

/** A phase (web `PhaseRow`): its ring, name and progress; it opens onto its agents on a curved trunk. */
function PhaseView({
  group,
  open,
}: {
  group: Extract<WorkflowGroupModel, { kind: 'phase' }>;
  open: (sessionId: string | null) => (() => void) | undefined;
}) {
  const palette = useTurnPalette();
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <PhaseHeader
        title={group.title!}
        progress={group.progress}
        ring={group.ring}
        meta={group.failed}
        expanded={expanded}
        // A phase with no agent yet (it just started) is a plain row: nothing to open.
        onPress={group.rows.length > 0 ? () => setExpanded((value) => !value) : undefined}
      />
      {expanded ? (
        <View style={{ marginLeft: PHASE_PAD + RING / 2 - 1 }}>
          {group.rows.map((row, index) => (
            <View key={row.id} style={{ position: 'relative' }}>
              {index < group.rows.length - 1 ? (
                <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: -1, left: 0, borderLeftWidth: 2, borderColor: palette.border }} />
              ) : null}
              {/* The elbow meets the row's first line at the middle of its 44pt touch row. */}
              <View
                pointerEvents="none"
                style={{ position: 'absolute', top: 0, left: 0, width: webSpace(3.5), height: 22, borderLeftWidth: 2, borderBottomWidth: 2, borderBottomLeftRadius: 6, borderColor: palette.border }}
              />
              <View style={{ marginLeft: webSpace(3.5) }}>
                <AgentRowView row={row} onPress={open(row.sessionId)} />
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function PhaseHeader({
  title,
  progress,
  ring,
  meta,
  muted = false,
  expanded,
  onPress,
}: {
  title: string;
  progress?: string | null;
  ring: { done: number; failed: number; total: number; ended: 'done' | 'stopped' | null };
  meta?: string | null;
  muted?: boolean;
  expanded?: boolean;
  onPress?: () => void;
}) {
  const palette = useTurnPalette();
  const body = (
    <>
      <RunProgressRing done={ring.done} failed={ring.failed} total={ring.total} ended={ring.ended} />
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: webSpace(1.5) }}>
        <Text numberOfLines={1} style={[TURN_TYPE.sm, { flexShrink: 1, color: muted ? palette.mutedForeground : palette.foreground }]}>
          {title}
        </Text>
        {progress ? <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground, fontVariant: ['tabular-nums'] }]}>{progress}</Text> : null}
      </View>
      {meta ? <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>{meta}</Text> : null}
      <View style={{ width: 14, opacity: onPress ? 1 : 0, transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}>
        <Icon as={CaretRightIcon} size={12} className="text-muted-foreground" />
      </View>
    </>
  );
  const rowStyle = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: webSpace(2.5), paddingHorizontal: PHASE_PAD, minHeight: 44, borderRadius: 8 };
  if (!onPress) return <View style={rowStyle}>{body}</View>;
  return (
    <PressableSurface
      accessibilityRole="button"
      accessibilityLabel={`${title}${progress ? `, ${progress}` : ''}`}
      accessibilityState={{ expanded: !!expanded }}
      onPress={onPress}
      style={({ pressed }) => [rowStyle, pressed && { backgroundColor: palette.pressed }]}
    >
      {body}
    </PressableSurface>
  );
}

function AgentRowView({ row, onPress }: { row: WorkflowAgentRowModel; onPress?: () => void }) {
  const palette = useTurnPalette();
  const body = (
    <>
      <SessionStatusMark status={row.glyph} />
      <View style={{ flex: 1, minWidth: 0, gap: webSpace(0.5) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(2.5) }}>
          <Text
            numberOfLines={1}
            style={[TURN_TYPE.sm, { flex: 1, color: palette.foreground }, row.glyph !== 'done' && { fontFamily: FONT_MEDIUM }]}
          >
            {row.label}
          </Text>
          {row.state ? (
            <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>{row.state}</Text>
          ) : null}
          {row.time ? <Text style={[TURN_TYPE.xs, { fontVariant: ['tabular-nums'], color: palette.mutedForeground }]}>{row.time}</Text> : null}
        </View>
        {row.reason ? (
          <Text numberOfLines={1} style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
            {row.reason}
          </Text>
        ) : null}
      </View>
    </>
  );
  const rowStyle = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: webSpace(2.5), paddingHorizontal: webSpace(2.5), minHeight: 44, borderRadius: 8 };
  if (!onPress) return <View style={rowStyle}>{body}</View>;
  return (
    <PressableSurface
      accessibilityRole="button"
      accessibilityLabel={`Open ${row.label}${row.state ? `, ${row.state}` : ''}`}
      onPress={onPress}
      style={({ pressed }) => [rowStyle, pressed && { backgroundColor: palette.pressed }]}
    >
      {body}
    </PressableSurface>
  );
}

ToolRegistry.register('workflow', WorkflowTool);
