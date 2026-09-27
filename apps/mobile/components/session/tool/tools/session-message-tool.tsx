/**
 * `session_message`. Port of apps/web `tool/tools/session-message-tool.tsx`:
 * `ChatCircle` · "Messaged a session" · the short session id · `sent` /
 * `failed`, closed by default; body is a "Message" section holding the first
 * 500 characters in an `OutputBlock` (`px-3 py-2`).
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { ChatCircleIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { sessionMessageArgs, shortSessionId } from '@/lib/session/tools/agents-session';
import { webSpace } from '@/lib/session/user-message';
import { BasicTool, partInput, partStatus } from '../shared/infrastructure';
import { OutputBlock, ToolSection } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function SessionMessageTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const sessionId = (input.session_id as string) || '';
  const message = (input.message as string) || '';
  const args = useMemo(() => sessionMessageArgs(status), [status]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={ChatCircleIcon}
      trigger={{ title: 'Messaged a session', subtitle: shortSessionId(sessionId), args }}
      defaultOpen={false}
      forceOpen={forceOpen}
    >
      {message ? (
        <View style={{ paddingHorizontal: TURN_SPACE.cardPad, paddingVertical: webSpace(2) }}>
          <ToolSection label="Message">
            <OutputBlock text={message.slice(0, 500)} />
          </ToolSection>
        </View>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_message', SessionMessageTool);
ToolRegistry.register('session-message', SessionMessageTool);
ToolRegistry.register('oc-session_message', SessionMessageTool);
ToolRegistry.register('oc-session-message', SessionMessageTool);
