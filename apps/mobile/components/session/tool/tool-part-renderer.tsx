/**
 * ToolPartRenderer — one tool call as a row.
 *
 * Mirrors apps/web `tool/tool-part-renderer.tsx`:
 * - `todoread` renders nothing;
 * - a thrown call (`state.status === 'error'`) is a `BasicTool` titled with the
 *   humanised tool name, subtitle "failed", the MCP server as its arg, and a
 *   `ToolError` body;
 * - every other call supplies the ambient row state (`ToolRunningContext`,
 *   `ToolOutcomeContext`, `StalePendingContext`, `ToolDurationContext`) and
 *   renders its row; a pending permission forces the row open, locks it, and
 *   shows the inline Deny / Allow always / Allow once prompt under it.
 *
 * Mobile rows use the registered tool renderer, or a raw-output fallback.
 */

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { getToolInfo, partOutcome, stripAnsi, type ToolPart as SdkToolPart } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import type { PermissionRequest } from '@/lib/opencode/types';
import { useSyncStore } from '@/lib/opencode/sync-store';
import { getDiffStats } from '@/lib/opencode/diff-utils';
import {
  isStalePending,
  isToolRunning,
  toolDisplayName,
  toolDurationMs,
} from '@/lib/session/activity';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { webSpace } from '@/lib/session/user-message';
import { useTabStore } from '@/stores/tab-store';
import {
  BasicTool,
  RawOutputBlock,
  StalePendingContext,
  ToolDurationContext,
  ToolOutcomeContext,
  ToolRunningContext,
  TurnLiveContext,
} from './shared/infrastructure';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from './shared/styles';
import { getToolIconByName } from './shared/tool-icons';
import { partInput } from '@/lib/session/tool-part-accessors';
import { ToolError } from './tool-error';
import { ToolRegistry } from './shared/registry';
export type PermissionReply = 'once' | 'always' | 'reject';

// ─── Permission prompt ───────────────────────────────────────────────────────

/**
 * The blocked tool row's marker for a pending permission. Deny / Allow
 * always / Allow once now live on `PermissionPromptCard`, pinned above the
 * composer (COR-137 Task 7) so the ask is never missed off-screen; this row
 * keeps only a quiet line so the reader can see which call is waiting.
 * Appears 50ms after mount, matching the previous inline prompt's timing.
 */
function PermissionPromptInline({ permission }: { permission: PermissionRequest }) {
  const palette = useTurnPalette();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <View
      style={{
        paddingHorizontal: webSpace(2.5),
        paddingVertical: TURN_SPACE.gap2,
      }}
    >
      <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>Waiting for your permission</Text>
    </View>
  );
}

// ─── ToolPartRenderer ────────────────────────────────────────────────────────

export interface ToolPartRendererProps {
  part: SdkToolPart;
  /** Reads the call's pending permission from the sync store when `permission` is not passed. */
  sessionId?: string;
  /** The owning turn is still working. Defaults to `TurnLiveContext`. */
  turnLive?: boolean;
  permission?: PermissionRequest;
  onPermissionReply?: (requestId: string, reply: PermissionReply) => void;
  defaultOpen?: boolean;
}

const EMPTY_PERMISSIONS: PermissionRequest[] = [];

function usePendingPermission(part: SdkToolPart, sessionId?: string, permissionProp?: PermissionRequest) {
  const sessionPermissions = useSyncStore((s) =>
    sessionId && !permissionProp ? s.permissions[sessionId] : undefined,
  ) ?? EMPTY_PERMISSIONS;
  return permissionProp ?? sessionPermissions.find((p) => p.tool?.callID === part.callID);
}

function RowAmbient({ running, stale, outcome, durationMs, permission, onPermissionReply, children }: {
  running: boolean;
  stale: boolean;
  outcome: ReturnType<typeof partOutcome>;
  durationMs: number | undefined;
  permission?: PermissionRequest;
  onPermissionReply?: ToolPartRendererProps['onPermissionReply'];
  children: React.ReactNode;
}) {
  return (
    <ToolRunningContext.Provider value={running}>
      <ToolOutcomeContext.Provider value={outcome}>
        <ToolDurationContext.Provider value={durationMs}>
          <StalePendingContext.Provider value={stale}>
            <View style={{ position: 'relative' }}>
              {children}
              {permission && onPermissionReply ? (
                <View style={{ marginTop: TURN_SPACE.gap1_5 }}>
                  <PermissionPromptInline permission={permission} />
                </View>
              ) : null}
            </View>
          </StalePendingContext.Provider>
        </ToolDurationContext.Provider>
      </ToolOutcomeContext.Provider>
    </ToolRunningContext.Provider>
  );
}

function ToolPartRendererImpl({
  part,
  sessionId,
  turnLive: turnLiveProp,
  permission: permissionProp,
  onPermissionReply,
  defaultOpen,
}: ToolPartRendererProps) {
  const ambientTurnLive = React.useContext(TurnLiveContext);
  const turnLive = turnLiveProp ?? ambientTurnLive;

  const permission = usePendingPermission(part, sessionId, permissionProp);

  const outcome = useMemo(() => partOutcome(part), [part]);
  const durationMs = useMemo(() => toolDurationMs(part), [part]);
  const stale = isStalePending(part, turnLive);
  const running = isToolRunning(part, turnLive);
  const forceOpen = Boolean(permission);
  const rowKey = disclosureKey('tool', part.id);

  // `getToolInput` also reads the legacy top-level `input` mobile parts may carry.
  const input = partInput(part);
  const info = getToolInfo(part.tool, input);

  const stat = useMemo(() => {
    if (part.tool !== 'edit' && part.tool !== 'morph_edit') return undefined;
    if (typeof input.oldString !== 'string' || typeof input.newString !== 'string') return undefined;
    return getDiffStats(input.oldString, input.newString);
  }, [part.tool, input.oldString, input.newString]);

  // Project tools open the project instead of expanding.
  const projectTarget = useMemo(() => {
    const normalized = part.tool.replace(/^oc-/, '').replace(/-/g, '_');
    if (normalized !== 'project_select' && normalized !== 'project_create') return null;
    if (part.state.status !== 'completed') return null;
    const output = typeof part.state.output === 'string' ? part.state.output : '';
    const idMatch = output.match(/proj-[a-z0-9-]+/);
    const projectId = idMatch ? idMatch[0] : (input.name as string) || (input.project as string) || '';
    if (!projectId) return null;
    return { projectId };
  }, [part.tool, part.state, input]);

  const openProject = useCallback(() => {
    if (!projectTarget) return;
    useTabStore.getState().navigateToPage(`page:project:${projectTarget.projectId}`);
  }, [projectTarget]);

  if (part.tool === 'todoread') return null;

  if (part.state.status === 'error') {
    const { display, server } = toolDisplayName(part.tool);
    return (
      <RowAmbient running={false} stale={false} outcome={outcome} durationMs={durationMs}>
          <BasicTool
            disclosureId={rowKey}
            trigger={{ title: display, subtitle: 'failed', args: server ? [server] : undefined }}
            defaultOpen={defaultOpen}
            forceOpen={forceOpen}
            locked={forceOpen}
          >
            <ToolError error={part.state.error} toolName={part.tool} partId={part.id} />
          </BasicTool>
      </RowAmbient>
    );
  }

  // A registered renderer owns its whole row, as on web (`tool/tools/*`).
  const Registered = ToolRegistry.get(part.tool);
  if (Registered) {
    return (
      <RowAmbient running={running} stale={stale} outcome={outcome} durationMs={durationMs} permission={permission} onPermissionReply={onPermissionReply}>
        <Registered
          part={part}
          sessionId={sessionId}
          defaultOpen={defaultOpen}
          forceOpen={forceOpen}
          locked={forceOpen}
          onPermissionReply={onPermissionReply}
        />
      </RowAmbient>
    );
  }

  const body = part.state.status === 'completed' && part.state.output?.trim()
    ? <RawOutputBlock output={stripAnsi(part.state.output).trim()} />
    : null;

  return (
    <RowAmbient running={running} stale={stale} outcome={outcome} durationMs={durationMs} permission={permission} onPermissionReply={onPermissionReply}>
      <BasicTool
        disclosureId={rowKey}
        icon={getToolIconByName(info.icon)}
        trigger={{ title: info.title, subtitle: info.subtitle, stat }}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={forceOpen}
        onPress={projectTarget ? openProject : undefined}
      >
        {body}
      </BasicTool>
    </RowAmbient>
  );
}

/** Default shallow compare: parts are replaced, not mutated, when they change. */
export const ToolPartRenderer = memo(ToolPartRendererImpl);
ToolPartRenderer.displayName = 'ToolPartRenderer';
