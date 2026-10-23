/**
 * The `kortix-connectors_*` tools — port of apps/web
 * `tool/tools/connector-tools.tsx`: `connectors` (the list), `discover`
 * (action search), `describe` (one action and its schema), `call` (one
 * connector call and its result).
 *
 * The status line and the RESULT stay open; the JSON that went in (request
 * arguments, input schema) folds. The fold decisions are
 * `CONNECTOR_CALL_SECTIONS` / `CONNECTOR_DESCRIBE_SCHEMA_SECTION`.
 */

import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useToast } from '@/components/kortix/toast-provider';
import {
  ClockIcon,
  CodeSimpleIcon,
  MagnifyingGlassIcon,
  PlugIcon,
  ShieldWarningIcon,
  TerminalWindowIcon,
} from '@/lib/icons';
import { useReviewItems, useReviewVerdict } from '@/lib/review/use-review';
import { planReviewVerdict } from '@/lib/review/review-verdict';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  approvalWaitingWhoKey,
  connectorApprovalNeed,
  connectorApprovalState,
  connectorConnectNeed,
  listPredatesCall,
  type ConnectorApprovalNeed,
} from '@/lib/session/connector-handoff';
import {
  CONNECTOR_CALL_SECTIONS,
  CONNECTOR_DESCRIBE_SCHEMA_SECTION,
  connectorCallView,
  connectorDescribeView,
  connectorDiscoverEmptyMessage,
  connectorDiscoverTrigger,
  connectorRowKey,
  connectorsTrigger,
  isToolStreaming,
  type ConnectorSection,
  type ConnectorTone,
} from '@/lib/session/tools/projects-connectors';
import { webSpace } from '@/lib/session/user-message';
import { ConnectorHandoffContext } from '../shared/connector-handoff-context';
import { ConnectorJson, ConnectorRiskBadge, parseConnectorOutput } from '../shared/error-and-connector';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolEmptyState,
  ToolOutputFallback,
  ToolRunningContext,
} from '../shared/infrastructure';
import { FoldedSection, ToolSection } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { FONT_MEDIUM, FONT_SEMIBOLD, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette, type TurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { ConnectorConnectRow } from './connector-connect-row';

/** Shared empty list: a fresh `[]` per render would re-render every row. */
const EMPTY_ROWS = Object.freeze([]) as readonly Record<string, unknown>[];

function toneColor(palette: TurnPalette, tone: ConnectorTone): string {
  return tone === 'success' ? palette.success : tone === 'warning' ? palette.warning : palette.destructive;
}

/** `text-[10px] font-semibold uppercase`. */
function StatusLabel({ children, color, style }: { children: string; color: string; style?: object }) {
  return (
    <Text
      variant="small"
      style={[TURN_TYPE.label10, { flexShrink: 0, fontFamily: FONT_SEMIBOLD, letterSpacing: 0, textTransform: 'uppercase', color }, style]}
    >
      {children}
    </Text>
  );
}

/** A labelled body section: folded (`FoldedSection`) or open (`ToolSection`). */
function Section({ section, children }: { section: ConnectorSection; children: ReactNode }) {
  return section.folded ? (
    <FoldedSection label={section.label}>{children}</FoldedSection>
  ) : (
    <ToolSection label={section.label}>{children}</ToolSection>
  );
}

// ─── connectors ──────────────────────────────────────────────────────────────

export function ConnectorsTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const output = partOutput(call);
  const status = partStatus(call);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseConnectorOutput(output), [output]);
  const connectors = (Array.isArray(parsed?.connectors) ? parsed.connectors : EMPTY_ROWS) as Record<string, unknown>[];
  const isStreaming = isToolStreaming(status, running);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', call.id)}
      icon={PlugIcon}
      trigger={connectorsTrigger(status, connectors.length)}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {connectors.length > 0 ? (
        <ToolResultCard bodyStyle={{ rowGap: webSpace(0.5) }}>
          {connectors.map((c) => (
            <View
              key={connectorRowKey(c)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: TURN_SPACE.gap2,
                paddingHorizontal: webSpace(2),
                paddingVertical: webSpace(1),
              }}
            >
              <PlugIcon size={TURN_SPACE.statusIcon} color={palette.muted50} />
              <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
                {String(c.name || c.slug || '')}
              </Text>
              <Text variant="muted" style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.muted60 }]}>
                {String(c.provider ?? '')}
              </Text>
              <Text variant="muted" style={[TURN_TYPE.xs, { marginLeft: 'auto', color: palette.muted50 }]}>
                {String(c.tools ?? 0)} tools
              </Text>
              <StatusLabel color={c.status === 'active' ? palette.success : palette.muted60}>
                {String(c.status ?? '')}
              </StatusLabel>
            </View>
          ))}
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="connectors" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message={isStreaming ? 'Loading connectors…' : 'No connectors.'} />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('kortix-connectors_connectors', ConnectorsTool);

// ─── discover ────────────────────────────────────────────────────────────────

export function ConnectorDiscoverTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(call);
  const output = partOutput(call);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);
  const status = partStatus(call);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseConnectorOutput(output), [output]);
  const matches = (Array.isArray(parsed?.matches) ? parsed.matches : EMPTY_ROWS) as Record<string, unknown>[];
  const trigger = connectorDiscoverTrigger(input, status, matches.length);
  const query = trigger.subtitle ?? '';
  const isStreaming = isToolStreaming(status, running);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', call.id)}
      icon={MagnifyingGlassIcon}
      trigger={trigger}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {outputIsError ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="discover" />
      ) : matches.length > 0 ? (
        <ToolResultCard bodyStyle={{ rowGap: webSpace(1.5) }}>
          {matches.map((m) => (
            <View
              key={String(m.tool ?? '') || String(m.description ?? '').slice(0, 60)}
              style={{ paddingHorizontal: webSpace(2), paddingVertical: webSpace(1) }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}>
                <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.foreground }]}>
                  {String(m.tool ?? '')}
                </Text>
                <ConnectorRiskBadge risk={m.risk} />
              </View>
              {m.description ? (
                <Text
                  variant="muted"
                  numberOfLines={2}
                  style={[TURN_TYPE.xsRelaxed, { marginTop: webSpace(0.5), color: palette.mutedForeground }]}
                >
                  {String(m.description)}
                </Text>
              ) : null}
            </View>
          ))}
        </ToolResultCard>
      ) : parsed ? (
        <ToolResultCard>
          <ToolEmptyState message={connectorDiscoverEmptyMessage(isStreaming, query, true)} />
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="discover" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message={connectorDiscoverEmptyMessage(isStreaming, query, false)} />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('kortix-connectors_discover', ConnectorDiscoverTool);

// ─── describe ────────────────────────────────────────────────────────────────

export function ConnectorDescribeTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(call);
  const output = partOutput(call);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);
  const status = partStatus(call);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseConnectorOutput(output), [output]);
  const view = connectorDescribeView(input, parsed);
  const isStreaming = isToolStreaming(status, running);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', call.id)}
      icon={CodeSimpleIcon}
      trigger={{ title: 'Inspected a connector action', subtitle: view.tool || undefined, args: view.triggerArgs }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {outputIsError ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="describe" />
      ) : parsed ? (
        <ToolResultCard bodyStyle={{ rowGap: webSpace(2.5), padding: webSpace(2) }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}>
            <Text style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.foreground }]}>{view.tool}</Text>
            <ConnectorRiskBadge risk={view.risk} />
          </View>
          {view.description ? (
            <Text variant="muted" style={[TURN_TYPE.xsRelaxed, { color: palette.mutedForeground }]}>
              {view.description}
            </Text>
          ) : null}
          {/* What the action is answers the card; its argument schema is for the model. */}
          <Section section={CONNECTOR_DESCRIBE_SCHEMA_SECTION}>
            <ConnectorJson value={view.schema} />
          </Section>
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="describe" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message={isStreaming ? 'Loading schema…' : 'No schema yet.'} />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('kortix-connectors_describe', ConnectorDescribeTool);

/** The review read the approval prompt polls: every pending approval, one page. */
const PENDING_APPROVALS = { kind: 'approval', limit: 200 } as const;

/**
 * ConnectorApprovalPrompt — a pending `kortix-connectors_call` approve/deny,
 * inline under its tool row (COR-158, connector remainder). The call is a
 * standalone transcript row (`standaloneCallIdsFor`), so this prompt always
 * renders inside the transcript's `ConnectorHandoffContext`.
 *
 * Not pinned above the composer like `PermissionPromptCard`: that card is
 * driven by session-wide state `SessionPage` already tracks
 * (`pendingPermissions`); a connector approval has no such state today.
 *
 * Pending is live, never the frozen tool output: `connectorApprovalState`
 * reads the project's review list (`useReviewItems`, the query `ReviewPage`
 * reads — the API lists a connector call there as `call:<execution_id>` only
 * while it waits). A call decided on web, on the Review page, or before a
 * remount shows its resolved state, not Approve / Deny. The prompt names the
 * action and previews its arguments, so the reader knows what they approve.
 *
 * The decision reuses `resolveApproval` — the same `@kortix/sdk` call
 * `ReviewPage`'s `useReviewVerdict` makes for its `resolve_approval` plan —
 * and refetches the same queries (`invalidateReviewItems`).
 *
 * Approve / Deny show only to a viewer the API lets decide the call (a project
 * manager or the person who started the session; `canResolve`, KRTX-1724).
 * Anyone else reads `waiting`: the call and who decides it, no decision.
 */
function ConnectorApprovalPrompt({
  need,
  callSettledAtMs,
}: {
  need: ConnectorApprovalNeed;
  callSettledAtMs: number | null;
}) {
  const handoff = useContext(ConnectorHandoffContext);
  const projectId = handoff?.projectId ?? null;
  const { t } = useTranslation();
  const toast = useToast();
  const [localDecision, setLocalDecision] = useState<'approve' | 'deny' | null>(null);
  // The same mutation `ReviewPage` uses: cancel-optimistic-write-invalidate,
  // one owner for the approve/deny lifecycle.
  const verdict = useReviewVerdict(projectId ?? '', {
    onSuccess: ({ verdict: sent }) => {
      setLocalDecision(sent === 'approve' ? 'approve' : 'deny');
      toast.success(sent === 'approve' ? 'Approved' : 'Denied');
    },
    onError: (cause) => toast.error(cause instanceof Error ? cause.message : 'Could not record the decision.'),
  });
  // Poll the review list only while the answer can still change. The pending
  // approvals only: the inbox is paged, and a pending call is never history
  // (KRTX-2316).
  const [polling, setPolling] = useState(true);
  const review = useReviewItems(projectId, { poll: polling, query: PENDING_APPROVALS });
  // The call's own verdict rides on its single action (`canResolve`), and so
  // does who decides it (`resolvers`).
  const reviewItems = useMemo(
    () =>
      review.data?.map((item) => {
        const call = item.kind === 'approval' ? item.detail.actions[0] : undefined;
        return {
          id: item.id,
          status: item.status,
          canResolve: call?.canResolve,
          resolvers: call?.resolvers,
        };
      }),
    [review.data],
  );
  const resolvers = reviewItems?.find((item) => item.id === `call:${need.executionId}`)?.resolvers;

  const state = connectorApprovalState({
    executionId: need.executionId,
    reviewItems,
    reviewFetchedAtMs: review.dataUpdatedAt,
    callSettledAtMs,
    localDecision,
  });
  // A waiting call still resolves elsewhere: keep polling for the outcome.
  const live = state === 'pending' || state === 'unknown' || state === 'waiting';
  useEffect(() => {
    setPolling(live);
  }, [live]);
  // A list fetched before this call settled cannot carry its verdict: ask now
  // instead of waiting out the 8 s poll (the card shows nothing meanwhile).
  const stale = review.dataUpdatedAt > 0 && listPredatesCall(review.dataUpdatedAt, callSettledAtMs);
  const { refetch } = review;
  useEffect(() => {
    if (stale) void refetch();
  }, [stale, refetch]);

  const decide = (decision: 'approve' | 'deny') => {
    if (!projectId) return;
    const sent = decision === 'approve' ? 'approve' : 'reject';
    const itemId = `call:${need.executionId}`;
    // A `call:` id always plans to `resolve_approval`; the guard is for types.
    const plan = planReviewVerdict(itemId, sent);
    if (plan) verdict.mutate({ itemId, verdict: sent, plan, kind: 'approval' });
  };

  // No project to decide in, or the live answer is not in yet: render nothing
  // rather than buttons that may belong to a call already decided.
  if (!projectId || state === 'unknown') return null;

  const details = (
    <>
      {need.actionRef ? (
        <Text selectable style={[TURN_TYPE.xs, { fontFamily: monoFont }]} className="text-foreground">
          {need.actionRef}
        </Text>
      ) : null}
      {need.argsPreview.map((arg) => (
        <View key={arg.key} className="flex-row gap-2">
          <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { fontFamily: monoFont, flexShrink: 0 }]}>
            {arg.key}
          </Text>
          <Text numberOfLines={2} style={[TURN_TYPE.xs, { flex: 1 }]} className="text-foreground">
            {arg.value}
          </Text>
        </View>
      ))}
    </>
  );

  if (state === 'waiting') {
    return (
      <View className="gap-2 rounded-xl border border-border bg-background p-3">
        <View className="flex-row items-center gap-1.5">
          <Icon as={ClockIcon} size={14} className="text-muted-foreground" />
          <Text variant="small" className="leading-5 text-muted-foreground">
            {t('approvals.waitingTitle')}
          </Text>
        </View>
        {details}
        <Text variant="muted" style={TURN_TYPE.xs}>
          {t(approvalWaitingWhoKey(resolvers))}
        </Text>
      </View>
    );
  }

  if (state !== 'pending') {
    return (
      <View className="gap-2 rounded-xl border border-border bg-background p-3">
        <Text variant="small" className="leading-5 text-muted-foreground">
          {state === 'approved' ? 'Approved' : state === 'denied' ? 'Denied' : 'Resolved'}
        </Text>
        {details}
      </View>
    );
  }

  return (
    <View className="gap-2 rounded-xl border border-kortix-orange/25 bg-background p-3">
      <View className="flex-row items-center gap-1.5">
        <Icon as={ShieldWarningIcon} size={14} className="text-kortix-orange" />
        <Text variant="small" className="leading-5 text-kortix-orange">
          Needs approval
        </Text>
      </View>
      {details}
      {need.summary ? (
        <Text variant="small" className="leading-5">
          {need.summary}
        </Text>
      ) : null}
      {need.instructions ? (
        <Text variant="muted" style={TURN_TYPE.xs}>
          {need.instructions}
        </Text>
      ) : null}
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={verdict.isPending}
            onPress={() => decide('deny')}>
            <Text>Deny</Text>
          </Button>
        </View>
        <View className="flex-1">
          <Button
            variant="default"
            size="sm"
            className="rounded-full"
            disabled={verdict.isPending}
            onPress={() => decide('approve')}>
            <Text>Approve</Text>
          </Button>
        </View>
      </View>
    </View>
  );
}

/** When a tool call settled (its `ended_at`, else `started_at`), epoch ms; `null` while it runs. */
function partSettledAtMs(call: ToolProps['call']): number | null {
  const at = call.ended_at ?? call.started_at;
  return at ? Date.parse(at) : null;
}

// ─── call ────────────────────────────────────────────────────────────────────

export function ConnectorCallTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(call);
  const output = partOutput(call);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);
  const status = partStatus(call);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseConnectorOutput(output), [output]);
  const view = useMemo(() => connectorCallView(input, parsed), [input, parsed]);
  const connectNeed = useMemo(() => connectorConnectNeed(input, parsed), [input, parsed]);
  const approvalNeed = useMemo(() => connectorApprovalNeed(input, parsed), [input, parsed]);
  const isStreaming = isToolStreaming(status, running);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', call.id)}
      icon={TerminalWindowIcon}
      trigger={{ title: 'Used a connector', subtitle: view.ref || undefined, args: view.triggerArgs }}
      // A connect-need or a pending approval is a call to action, not history
      // to fold away — the row opens on its own, same as a forced-open
      // permission prompt.
      defaultOpen={defaultOpen || !!connectNeed || !!approvalNeed}
      forceOpen={forceOpen}
      locked={locked}
    >
      <>
        <ToolResultCard bodyStyle={{ rowGap: webSpace(2.5), padding: webSpace(2) }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}>
            <Text style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.foreground }]}>{view.ref}</Text>
            <ConnectorRiskBadge risk={parsed?.risk} />
            {view.outcome ? (
              <StatusLabel color={toneColor(palette, view.outcome.tone)} style={{ marginLeft: 'auto' }}>
                {view.outcome.label}
              </StatusLabel>
            ) : null}
          </View>

          {Object.keys(view.args).length > 0 ? (
            <Section section={CONNECTOR_CALL_SECTIONS.request}>
              <ConnectorJson value={view.args} />
            </Section>
          ) : null}

          {!outputIsError && view.response ? (
            <Section section={CONNECTOR_CALL_SECTIONS.response}>
              {view.response.kind === 'reason' ? (
                <Text selectable style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.destructive }]}>
                  {view.response.text}
                </Text>
              ) : (
                <ConnectorJson value={view.response.value} />
              )}
            </Section>
          ) : output ? null : (
            <ToolEmptyState message={isStreaming ? 'Running…' : 'No result yet.'} />
          )}
        </ToolResultCard>

        {/* The fallback draws its own card, so it stacks below rather than nesting. */}
        {outputIsError || (!parsed && output) ? (
          <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="call" />
        ) : null}

        {/* The two remedies a denied/pending call can ask a human for — never
            both at once, since a call is either unconnected or awaiting a
            decision, not both. */}
        {connectNeed ? (
          <View style={{ marginTop: webSpace(2) }}>
            <ConnectorConnectRow
              slug={connectNeed.slug}
              label={connectNeed.label}
              fallbackConnectUrl={connectNeed.connectUrl}
            />
          </View>
        ) : approvalNeed ? (
          <View style={{ marginTop: webSpace(2) }}>
            <ConnectorApprovalPrompt need={approvalNeed} callSettledAtMs={partSettledAtMs(call)} />
          </View>
        ) : null}
      </>
    </BasicTool>
  );
}
ToolRegistry.register('kortix-connectors_call', ConnectorCallTool);
