/**
 * `agent_message`. Port of apps/web `tool/tools/agent-message-tool.tsx`:
 * `ChatCircle` · "Message agent" · the task id's last 12 characters (tappable
 * when the call names a worker session: web opens `SubSessionModal`, mobile
 * opens the session in the app) · `failed`; body is the error fallback or the
 * message (`px-3 py-2 text-xs leading-relaxed`, muted, pre-wrapped).
 */

import { useCallback, useMemo } from 'react';
import { getChildSessionId } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { ChatCircleIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { agentMessageModel } from '@/lib/session/tools/agents-status';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolOutputFallback,
  partInput,
  partOutput,
  partStatus,
  useToolNavigation,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function AgentMessageTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);
  const model = useMemo(() => agentMessageModel({ status, input, output }), [status, input, output]);
  const childSessionId = useMemo(() => getChildSessionId(part), [part]);
  const { enabled: navigationEnabled, openSession } = useToolNavigation();

  const openChild = useCallback(() => {
    if (childSessionId) openSession(childSessionId);
  }, [childSessionId, openSession]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={ChatCircleIcon}
      trigger={{ title: model.title, subtitle: model.subtitle, args: model.args }}
      onSubtitleClick={childSessionId && navigationEnabled ? openChild : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {model.isError ? (
        <ToolOutputFallback output={output} toolName="agent_message" />
      ) : model.rawMessage ? (
        <Text
          variant="muted"
          selectable
          style={[
            TURN_TYPE.xsRelaxed,
            { paddingHorizontal: TURN_SPACE.cardPad, paddingVertical: webSpace(2), color: palette.mutedForeground },
          ]}
        >
          {model.rawMessage}
        </Text>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('agent_message', AgentMessageTool);
ToolRegistry.register('agent-message', AgentMessageTool);
