/**
 * ProjectHeaderActions — the right end of the floating header on project home,
 * in a thread, and on a connecting session (Jay, 2026-09-21): the agent pill
 * (`children`), then the `···` button that opens the project sheet
 * (`CustomizeSheet`: agents, skills, schedules, review, models, secrets).
 *
 * The `···` button is always there; the pill hides itself with fewer than two
 * agents. `-mr-2.5` mirrors `MenuButton`'s `-ml-2.5`: the 20pt glyph's right
 * edge sits on the page's 16pt padding edge. The pill inside passes
 * `edge={false}`, because the `···` button holds the edge.
 */
import * as React from 'react';
import { Keyboard, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { DotsThreeIcon } from '@/lib/icons';

interface ProjectHeaderActionsProps {
  onOpenMore: () => void;
  /** `AgentPill`. */
  children?: React.ReactNode;
}

export function ProjectHeaderActions({ onOpenMore, children }: ProjectHeaderActionsProps) {
  return (
    <View className="shrink flex-row items-center">
      {children}
      <Button
        variant="ghost"
        size="icon"
        className="-mr-2.5 rounded-full bg-background"
        onPress={() => {
          Keyboard.dismiss();
          onOpenMore();
        }}
        accessibilityLabel="Project sections"
        accessibilityHint="Opens agents, skills, schedules, review, models and secrets"
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Icon as={DotsThreeIcon} size={20} className="text-foreground" />
      </Button>
    </View>
  );
}
