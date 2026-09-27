/**
 * `task` — a sub-agent dispatch as a disclosure row. Port of apps/web
 * `tool/tools/task-tool.tsx`.
 *
 * - trigger: `Kanban` · "Agent · <subagent_type>" · subtitle = the sub-agent's
 *   LAST step while it runs, else the description; badge "N steps" once settled;
 * - body: the sub-agent's steps (`SubAgentActivity`), only when there are steps
 *   (an empty disclosure is a caret onto nothing);
 * - "View" on the trigger's right edge opens the child session. Web opens
 *   `SubSessionModal`; mobile has no sub-session modal, so it opens the child
 *   session in the app (`useToolNavigation().openSession` → the tab store);
 * - a child session whose steps are not in memory makes the whole row a button
 *   onto that session, so the row never looks openable and does nothing.
 */

import { useCallback, useMemo } from 'react';
import { Pressable } from 'react-native';
import { getChildSessionId } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { KanbanIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { taskRowModel } from '@/lib/session/tools/agents-task';
import { webSpace } from '@/lib/session/user-message';
import { BasicTool, partInput, partStatus, useToolNavigation } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_TYPE, useTurnPalette } from '../shared/styles';
import { useToolRowVariant } from '../shared/surface';
import type { ToolProps } from '../shared/types';
import { SubAgentActivity, SubAgentStatusBanner, useChildSession } from './sub-agent';

const ACTION_HIT_SLOP = { top: webSpace(3), bottom: webSpace(3), left: webSpace(2), right: webSpace(2) };

/**
 * Web `FullViewAction`: visible label "View", accessible name "Open full view"
 * (contains the visible text, WCAG 2.5.3), `text-muted-foreground/60`, always
 * visible (no hover on touch). A text action on the trigger, like the row's
 * tappable subtitle, so it does not add a button box to a 24pt row.
 */
function FullViewAction({ onOpen }: { onOpen: () => void }) {
  const palette = useTurnPalette();
  const { chain } = useToolRowVariant();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Open full view" onPress={onOpen} hitSlop={ACTION_HIT_SLOP}>
      <Text variant="muted" style={[chain ? TURN_TYPE.rowSm : TURN_TYPE.sm, { color: palette.muted60 }]}>
        View
      </Text>
    </Pressable>
  );
}

export function TaskTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const childSessionId = useMemo(() => getChildSessionId(part), [part]);
  const { childMessages, childToolParts } = useChildSession(childSessionId);
  const { enabled: navigationEnabled, openSession } = useToolNavigation();

  const model = useMemo(
    () => taskRowModel({ status, input, childSessionId, childToolParts }),
    [status, input, childSessionId, childToolParts],
  );

  const openFullView = useCallback(() => {
    if (childSessionId) openSession(childSessionId);
  }, [childSessionId, openSession]);

  // Inside a sub-agent list navigation is off (web `disableNavigation`), so an
  // action that cannot navigate is not drawn.
  const canOpen = navigationEnabled && model.showFullViewAction;

  return (
    <>
      <BasicTool
        disclosureId={disclosureKey('tool', part.id)}
        icon={KanbanIcon}
        trigger={{ title: model.title, subtitle: model.subtitle }}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
        badge={model.badge}
        triggerAction={canOpen ? <FullViewAction onOpen={openFullView} /> : undefined}
        onClick={canOpen && model.rowOpensSession ? openFullView : undefined}
      >
        {model.hasInlineSteps ? (
          <SubAgentActivity childSessionId={childSessionId} parts={childToolParts} />
        ) : undefined}
      </BasicTool>
      <SubAgentStatusBanner childSessionId={childSessionId} childMessages={childMessages} />
    </>
  );
}
ToolRegistry.register('task', TaskTool);
