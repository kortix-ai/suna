/**
 * `session_spawn` / `session_start_background`. Port of apps/web
 * `tool/tools/session-spawn-tool.tsx`, which draws its own trigger row rather
 * than `BasicTool`:
 * - row: `flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/70`,
 *   `Cpu` (muted/50, `size-3.5`); a press target with "Worker · <Agent>", the
 *   label in mono muted (the worker's last step while it runs), a running mark
 *   or "N steps" (mono muted/60) at the right; then "Open session ↗";
 * - with `forceOpen`, the worker's steps below (`SubAgentActivity`); then the
 *   worker's retry/error banner. In the activity sheet's detail
 *   (`ToolDetailContext` `body`), the steps and banner alone.
 *
 * Web's press target opens `SubSessionModal` and "Open session" navigates to
 * `/projects/:id/sessions/:sid?oc=<child>` (`session-spawn-urls.ts`). Mobile
 * has neither a sub-session modal nor URL routes inside a project, so both
 * open the child session in the app (`useToolNavigation().openSession`).
 * Web's running mark is a pulsing dot; mobile's loading rule allows only
 * `KortixLoader`, so the mark is `KortixLoader` at `size-3`.
 */

import { useCallback, useContext, useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { getChildSessionId } from '@kortix/sdk';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Text } from '@/components/ui/text';
import { ArrowSquareOutIcon, CpuIcon } from '@/lib/icons';
import { sessionSpawnModel } from '@/lib/session/tools/agents-spawn';
import { webSpace } from '@/lib/session/user-message';
import { partInput, partStatus, useToolNavigation } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import { ToolDetailContext } from '../shared/surface';
import type { ToolProps } from '../shared/types';
import { SubAgentActivity, SubAgentStatusBanner, useChildSession } from './sub-agent';

const HIT_SLOP = { top: webSpace(2), bottom: webSpace(2) };

export function SessionSpawnTool({ part, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const status = partStatus(part);
  const childSessionId = useMemo(() => getChildSessionId(part), [part]);
  const { childMessages, childToolParts } = useChildSession(childSessionId);
  const { enabled: navigationEnabled, openSession } = useToolNavigation();
  const detail = useContext(ToolDetailContext);

  const model = useMemo(
    () => sessionSpawnModel({ status, input, childToolParts }),
    [status, input, childToolParts],
  );

  const canOpen = Boolean(childSessionId) && navigationEnabled;
  const openChild = useCallback(() => {
    if (childSessionId) openSession(childSessionId);
  }, [childSessionId, openSession]);

  // The activity sheet's detail names the worker already: show its steps alone.
  if (detail === 'body') {
    return (
      <ToolDetailContext.Provider value="nested">
        <SubAgentActivity childSessionId={childSessionId} parts={childToolParts} />
        <SubAgentStatusBanner childSessionId={childSessionId} childMessages={childMessages} />
      </ToolDetailContext.Provider>
    );
  }

  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: TURN_SPACE.gap1_5,
          paddingVertical: TURN_SPACE.rowPadY,
          maxWidth: '100%',
        }}
      >
        <View style={{ flexShrink: 0 }}>
          <CpuIcon size={TURN_SPACE.caret} color={palette.muted50} />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${model.titleLabel}${model.label ? `: ${model.label}` : ''}`}
          disabled={!canOpen}
          onPress={openChild}
          hitSlop={HIT_SLOP}
          style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5, overflow: 'hidden' }}
        >
          <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 0, color: palette.muted70 }]}>
            {model.titleLabel}
          </Text>
          {model.subtitle ? (
            <Text
              variant="muted"
              numberOfLines={1}
              style={[TURN_TYPE.xs, { flexShrink: 1, minWidth: 0, fontFamily: monoFont, color: palette.mutedForeground }]}
            >
              {model.subtitle}
            </Text>
          ) : null}
          {model.isRunning ? (
            <View style={{ marginLeft: 'auto', flexShrink: 0 }}>
              <KortixLoader customSize={TURN_SPACE.statusIcon} />
            </View>
          ) : null}
          {model.stepsLabel ? (
            <Text
              variant="muted"
              numberOfLines={1}
              style={[TURN_TYPE.xs, { marginLeft: 'auto', flexShrink: 0, fontFamily: monoFont, color: palette.muted60 }]}
            >
              {model.stepsLabel}
            </Text>
          ) : null}
        </Pressable>
        {canOpen ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open session"
            onPress={openChild}
            hitSlop={HIT_SLOP}
            style={{
              flexShrink: 0,
              flexDirection: 'row',
              alignItems: 'center',
              gap: webSpace(1),
              paddingHorizontal: webSpace(1.5),
            }}
          >
            <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.foreground }]}>
              Open session
            </Text>
            <ArrowSquareOutIcon size={TURN_SPACE.statusIcon} color={palette.foreground} />
          </Pressable>
        ) : null}
      </View>
      {forceOpen && childToolParts.length > 0 ? (
        <SubAgentActivity childSessionId={childSessionId} parts={childToolParts} />
      ) : null}
      <SubAgentStatusBanner childSessionId={childSessionId} childMessages={childMessages} />
    </>
  );
}
ToolRegistry.register('session_spawn', SessionSpawnTool);
ToolRegistry.register('session-spawn', SessionSpawnTool);
ToolRegistry.register('oc-session_spawn', SessionSpawnTool);
ToolRegistry.register('oc-session-spawn', SessionSpawnTool);
ToolRegistry.register('session_start_background', SessionSpawnTool);
ToolRegistry.register('session-start-background', SessionSpawnTool);
ToolRegistry.register('oc-session_start_background', SessionSpawnTool);
ToolRegistry.register('oc-session-start-background', SessionSpawnTool);
