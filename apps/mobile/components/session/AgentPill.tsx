/**
 * AgentPill — the header's agent control on project home and in a thread, at
 * the right end of the hamburger's row (Jay, 2026-09-21).
 *
 * Agent name + caret on a ghost pill (`bg-background`, the hamburger's fill,
 * so turns scrolling under the header do not show through). It opens a
 * `PickerSheet` of the project's agents: label, check on the active one.
 * Choosing applies and closes.
 *
 * Hidden when there is nothing to choose: fewer than two pickable agents
 * (`pickableAgents`: primary, not hidden, not disabled). The agent is a
 * thread-level choice, so it lives in the header; the composer keeps the
 * per-message controls (files, model, send). The thread passes the sandbox's
 * agents; project home has no sandbox and passes the project config's.
 *
 * `-mr-2.5` mirrors `MenuButton`'s `-ml-2.5`: the pressed pill ends 6pt from
 * the screen edge, like the hamburger's pressed circle on the left.
 */
import * as React from 'react';
import { Keyboard } from 'react-native';

import type { SheetRef } from '@/components/kortix/sheet';
import { PickerSheet } from '@/components/session/PickerSheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { CaretDownIcon } from '@/lib/icons';
import { agentDisplayName, pickableAgents, type PickerOption } from '@/lib/session/composer-config';

interface AgentPillProps {
  agents: Array<{ name: string; mode?: string | null; hidden?: boolean; enabled?: boolean }>;
  /** The agent the next message runs on. Null: none resolved, the pill reads "Agent". */
  activeName: string | null;
  onChange: (name: string) => void;
}

export function AgentPill({ agents, activeName, onChange }: AgentPillProps) {
  const sheetRef = React.useRef<SheetRef>(null);
  const options = React.useMemo<PickerOption[]>(
    () => pickableAgents(agents).map((a) => ({ key: a.name, label: agentDisplayName(a.name) })),
    [agents],
  );

  if (options.length < 2) return null;
  const name = agentDisplayName(activeName ?? undefined);

  return (
    <>
      <Button
        variant="ghost"
        className="-mr-2.5 shrink rounded-full bg-background"
        onPress={() => {
          Keyboard.dismiss();
          sheetRef.current?.open();
        }}
        accessibilityLabel={`Agent, ${name}`}
        accessibilityHint="Opens the agent list">
        <Text numberOfLines={1}>{name}</Text>
        <Icon as={CaretDownIcon} size={14} className="text-muted-foreground" />
      </Button>
      <PickerSheet
        ref={sheetRef}
        title="Agent"
        options={options}
        activeKey={activeName}
        onSelect={onChange}
        searchLabel="Search agents"
        emptyLabel="No matching agents"
      />
    </>
  );
}
