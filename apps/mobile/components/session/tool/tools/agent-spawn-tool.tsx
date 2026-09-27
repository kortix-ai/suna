/**
 * `agent_spawn` and its aliases (`agent_task`, `agent_task_create`,
 * `agent_task_start`, `task_create`, `task_start`). Port of apps/web
 * `tool/tools/agent-spawn-tool.tsx`.
 *
 * - trigger: `Cpu` · "Spawn agent" · subtitle = the worker's last step while it
 *   runs, "failed" on a `{success:false}` payload, else the card label; a
 *   tappable subtitle opens the child session (web: `SubSessionModal`; mobile
 *   opens the session in the app); badge "N steps";
 * - body: one `ToolResultCard` (`space-y-2 px-2 py-1.5`) with the verification
 *   condition (`✓ …`, muted/60) and the worker's output as markdown, or its last
 *   three steps and "+N more"; a failure keeps the verification card and adds
 *   `ToolOutputFallback`; then the child's retry/error banner.
 */

import { useCallback, useContext, useMemo } from 'react';
import { View } from 'react-native';
import { getChildSessionId } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { CheckIcon, CpuIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { agentSpawnModel } from '@/lib/session/tools/agents-spawn';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolOutputFallback,
  ToolResultCard,
  ToolSurfaceContext,
  partInput,
  partOutput,
  partStatus,
  useToolNavigation,
} from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { SubAgentActivity, SubAgentStatusBanner, useChildSession } from './sub-agent';

function VerificationLine({ text }: { text: string }) {
  const palette = useTurnPalette();
  return (
    <Text variant="muted" style={[TURN_TYPE.xsRelaxed, { color: palette.muted60 }]}>
      ✓ {text}
    </Text>
  );
}

export function AgentSpawnTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const surface = useContext(ToolSurfaceContext);
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);
  const childSessionId = useMemo(() => getChildSessionId(part), [part]);
  const { childMessages, childToolParts } = useChildSession(childSessionId);
  const { enabled: navigationEnabled, openSession } = useToolNavigation();

  const model = useMemo(
    () => agentSpawnModel({ status, input, output, childToolParts }),
    [status, input, output, childToolParts],
  );

  const openChild = useCallback(() => {
    if (childSessionId) openSession(childSessionId);
  }, [childSessionId, openSession]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={CpuIcon}
      trigger={{ title: model.title, subtitle: model.subtitle }}
      onSubtitleClick={childSessionId && navigationEnabled ? openChild : undefined}
      badge={model.badge}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {model.body === 'failure' ? (
        <>
          {model.verification ? (
            <ToolResultCard>
              <View style={{ paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}>
                <VerificationLine text={model.verification} />
              </View>
            </ToolResultCard>
          ) : null}
          <ToolOutputFallback output={output} toolName="agent_spawn" />
        </>
      ) : model.body === 'card' ? (
        <ToolResultCard>
          <View style={{ rowGap: webSpace(2), paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}>
            {model.verification ? <VerificationLine text={model.verification} /> : null}

            {model.isCompleted && model.cleanedOutput ? (
              <OutputBlock text={model.cleanedOutput} markdown />
            ) : model.recentSteps.length > 0 ? (
              <View style={{ rowGap: webSpace(0.5) }}>
                {model.recentSteps.map((recent) => (
                  <View
                    key={recent.id}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}
                  >
                    <CheckIcon size={webSpace(2.5)} color={palette.muted50} />
                    <Text
                      variant="muted"
                      numberOfLines={1}
                      style={[TURN_TYPE.xs, { flexShrink: 1, color: palette.mutedForeground }]}
                    >
                      {recent.label}
                    </Text>
                  </View>
                ))}
                {model.moreLabel ? (
                  <Text
                    variant="muted"
                    style={[TURN_TYPE.xs, { paddingLeft: webSpace(4), color: palette.muted50 }]}
                  >
                    {model.moreLabel}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        </ToolResultCard>
      ) : null}

      {surface === 'panel' && childToolParts.length > 0 ? (
        <View
          style={{
            marginHorizontal: -TURN_SPACE.cardPad,
            borderTopWidth: 1,
            borderTopColor: palette.border30,
            paddingHorizontal: TURN_SPACE.cardPad,
            paddingTop: TURN_SPACE.cardPad,
          }}
        >
          <SubAgentActivity childSessionId={childSessionId} parts={childToolParts} />
        </View>
      ) : null}

      <SubAgentStatusBanner childSessionId={childSessionId} childMessages={childMessages} />
    </BasicTool>
  );
}
ToolRegistry.register('agent_spawn', AgentSpawnTool);
ToolRegistry.register('agent-spawn', AgentSpawnTool);

ToolRegistry.register('agent_task', AgentSpawnTool);
ToolRegistry.register('agent-task', AgentSpawnTool);
ToolRegistry.register('agent_task_create', AgentSpawnTool);
ToolRegistry.register('agent-task-create', AgentSpawnTool);
ToolRegistry.register('agent_task_start', AgentSpawnTool);
ToolRegistry.register('agent-task-start', AgentSpawnTool);
ToolRegistry.register('task_create', AgentSpawnTool);
ToolRegistry.register('task-create', AgentSpawnTool);
ToolRegistry.register('task_start', AgentSpawnTool);
ToolRegistry.register('task-start', AgentSpawnTool);
