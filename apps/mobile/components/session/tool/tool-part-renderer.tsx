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
 * Mobile has no per-tool trigger components yet: the row's icon, title and
 * subtitle come from `getToolInfo`, and the expanded body is the existing
 * `tool/tools/*` renderer chosen by `getExpandedContent`, hosted in the web
 * output card (`ToolCardFrame`).
 */

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { getToolInfo, partOutcome, stripAnsi, type ToolPart as SdkToolPart } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import type { PermissionRequest, ToolPart } from '@/lib/opencode/types';
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
import { ToolCardFrame } from './shared/surface';
import { getToolIconByName } from './shared/tool-icons';
import { getToolInput } from './shared/tool-part';
import { ToolError } from './tool-error';
import { ToolRegistry } from './shared/registry';
import { GenericExpandedContent } from './generic-tool';
import { ShellExpandedContent } from './tools/bash-tool';
import { WriteEditExpandedContent } from './tools/edit-tool';
import { TodosExpandedContent } from './tools/todo-write-tool';
import { ReadExpandedContent } from './tools/read-tool';
import { WebSearchExpandedContent } from './tools/web-search-tool';
import { GlobGrepExpandedContent } from './tools/glob-tool';
import { QuestionExpandedContent } from './tools/question-tool';
import { GetMemExpandedContent } from './tools/get-mem-tool';
import { LtmSearchExpandedContent } from './tools/memory-search-tool';
import { SessionGetExpandedContent } from './tools/session-get-tool';

export type PermissionReply = 'once' | 'always' | 'reject';

// ─── Expanded content by tool type ───────────────────────────────────────────

/**
 * The per-tool body, or `null` for tools without a dedicated renderer (the
 * caller then shows the raw output card).
 */
export function getExpandedContent(tool: ToolPart, isDark: boolean): React.ReactNode {
  switch (tool.tool) {
    case 'bash':
      return <ShellExpandedContent tool={tool} isDark={isDark} />;
    case 'write':
    case 'edit':
    case 'morph_edit':
      return <WriteEditExpandedContent tool={tool} isDark={isDark} />;
    case 'todowrite':
      return <TodosExpandedContent tool={tool} isDark={isDark} />;
    case 'read':
      return <ReadExpandedContent tool={tool} isDark={isDark} />;
    case 'websearch':
    case 'web-search':
    case 'web_search':
      return <WebSearchExpandedContent tool={tool} isDark={isDark} />;
    case 'glob':
    case 'grep':
    case 'list':
      return <GlobGrepExpandedContent tool={tool} isDark={isDark} />;
    case 'question':
      return <QuestionExpandedContent tool={tool} isDark={isDark} />;
    case 'get_mem':
    case 'get-mem':
    case 'oc-get_mem':
    case 'oc-get-mem':
      return <GetMemExpandedContent tool={tool} isDark={isDark} />;
    case 'ltm_search':
    case 'ltm-search':
    case 'mem_search':
    case 'mem-search':
    case 'memory_search':
    case 'memory-search':
    case 'oc-mem_search':
    case 'oc-mem-search':
      return <LtmSearchExpandedContent tool={tool} isDark={isDark} />;
    case 'session_get':
    case 'session-get':
    case 'oc-session_get':
    case 'oc-session-get':
      return <SessionGetExpandedContent tool={tool} isDark={isDark} />;
    default:
      return null;
  }
}

/** Kept for callers of the previous row: `GenericExpandedContent` is the old fallback body. */
export { GenericExpandedContent };

export function toolHasExpandableContent(tool: ToolPart): boolean {
  const { state } = tool;
  const input = getToolInput(tool);
  if (state.status === 'running' || state.status === 'pending') return true;
  if (tool.tool === 'todowrite' && Array.isArray(input.todos) && input.todos.length > 0) return true;
  if (tool.tool === 'bash' && (input.command || input.description)) return true;
  if (
    (tool.tool === 'write' || tool.tool === 'edit' || tool.tool === 'morph_edit') &&
    (input.content || input.oldString || input.newString)
  )
    return true;
  if (tool.tool === 'question') return true;
  if (state.status === 'completed' && 'output' in state && state.output?.trim()) return true;
  if (state.status === 'error' && 'error' in state && state.error) return true;
  return false;
}

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

function ToolPartRendererImpl({
  part,
  sessionId,
  turnLive: turnLiveProp,
  permission: permissionProp,
  onPermissionReply,
  defaultOpen,
}: ToolPartRendererProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const ambientTurnLive = React.useContext(TurnLiveContext);
  const turnLive = turnLiveProp ?? ambientTurnLive;

  const sessionPermissions = useSyncStore((s) =>
    sessionId && !permissionProp ? s.permissions[sessionId] : undefined,
  ) ?? EMPTY_PERMISSIONS;
  const permission =
    permissionProp ?? sessionPermissions.find((p) => p.tool?.callID === part.callID);

  const mobilePart = part as unknown as ToolPart;
  const outcome = useMemo(() => partOutcome(part), [part]);
  const durationMs = useMemo(() => toolDurationMs(part), [part]);
  const stale = isStalePending(part, turnLive);
  const running = isToolRunning(part, turnLive);
  const forceOpen = Boolean(permission);
  const rowKey = disclosureKey('tool', part.id);

  // `getToolInput` also reads the legacy top-level `input` mobile parts may carry.
  const input = getToolInput(mobilePart);
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
      <ToolOutcomeContext.Provider value={outcome}>
        <ToolDurationContext.Provider value={durationMs}>
          <BasicTool
            disclosureId={rowKey}
            trigger={{ title: display, subtitle: 'failed', args: server ? [server] : undefined }}
            defaultOpen={defaultOpen}
            forceOpen={forceOpen}
            locked={forceOpen}
          >
            <ToolError error={part.state.error} toolName={part.tool} partId={part.id} />
          </BasicTool>
        </ToolDurationContext.Provider>
      </ToolOutcomeContext.Provider>
    );
  }

  // A registered renderer owns its whole row, as on web (`tool/tools/*`).
  const Registered = ToolRegistry.get(part.tool);
  if (Registered) {
    return (
      <ToolRunningContext.Provider value={running}>
        <ToolOutcomeContext.Provider value={outcome}>
          <ToolDurationContext.Provider value={durationMs}>
            <StalePendingContext.Provider value={stale}>
              <View style={{ position: 'relative' }}>
                <Registered
                  part={part}
                  sessionId={sessionId}
                  defaultOpen={defaultOpen}
                  forceOpen={forceOpen}
                  locked={forceOpen}
                  onPermissionReply={onPermissionReply}
                />
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

  const body = (() => {
    if (!toolHasExpandableContent(mobilePart)) return null;
    const content = getExpandedContent(mobilePart, isDark);
    if (content) {
      return <ToolCardFrame padded={false}>{content}</ToolCardFrame>;
    }
    if (part.state.status === 'completed' && part.state.output?.trim()) {
      return <RawOutputBlock output={stripAnsi(part.state.output).trim()} />;
    }
    return null;
  })();

  return (
    <ToolRunningContext.Provider value={running}>
      <ToolOutcomeContext.Provider value={outcome}>
        <ToolDurationContext.Provider value={durationMs}>
          <StalePendingContext.Provider value={stale}>
            <View style={{ position: 'relative' }}>
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

/** Default shallow compare: parts are replaced, not mutated, when they change. */
export const ToolPartRenderer = memo(ToolPartRendererImpl);
ToolPartRenderer.displayName = 'ToolPartRenderer';

// ─── Legacy call shape ───────────────────────────────────────────────────────

/**
 * The previous row's props (`tool`, `isDark`, `working`), kept until
 * `SessionTurn.tsx` composes `ActivityBurst` / `ToolPartRenderer` directly.
 */
export const ToolCard = memo(function ToolCard({
  tool,
  working,
}: {
  tool: ToolPart;
  isDark?: boolean;
  working: boolean;
}) {
  return <ToolPartRenderer part={tool as unknown as SdkToolPart} turnLive={working} />;
});

// Registers every tool renderer (web: the same import at the end of tool-part-renderer.tsx).
import './tools/register';
