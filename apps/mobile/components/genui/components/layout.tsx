import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ScrollView as GHScrollView } from 'react-native-gesture-handler';
import type { GenuiNode } from '@kortix/sdk/genui';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';

import { GenuiImageView } from './inline';
import { openGenuiLink } from './open-link';

export const kids = (value: unknown): GenuiNode[] => (Array.isArray(value) ? (value as GenuiNode[]) : []);

/** Phones are narrow: a Stack is always a column on mobile; StatRow handles its own grid. */
export function GenuiStack({ props, renderChild }: GenuiComponentProps) {
  return <View className="gap-3">{kids(props.children).map(renderChild)}</View>;
}

export function GenuiCard({ props, renderChild }: GenuiComponentProps) {
  const badges = kids(props.badges);
  const body = (
    <View className="gap-1 rounded-2xl bg-card px-4 py-3">
      {/* Decorative: the title below names the item. */}
      {props.image ? <GenuiImageView src={props.image} alt="" /> : null}
      <Text variant="large">{props.title}</Text>
      {props.subtitle ? <Text variant="muted">{props.subtitle}</Text> : null}
      {props.body ? <Text>{props.body}</Text> : null}
      {badges.length > 0 ? <View className="mt-1 flex-row flex-wrap gap-1.5">{badges.map(renderChild)}</View> : null}
    </View>
  );
  return props.href ? (
    <Pressable accessibilityRole="link" className="active:opacity-70" onPress={() => openGenuiLink(props.href)}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

export function GenuiTabs({ props, renderChild, streaming }: GenuiComponentProps) {
  const tabs = kids(props.tabs);
  // A top-down stream mounts Tabs before its tabs exist, so the first tab is resolved at render, not at mount.
  const [value, setValue] = useState<string | null>(null);
  if (tabs.length === 0) return null;
  // While streaming, show the tab being written so progress is visible (spec §6.3).
  const active = streaming ? tabs.at(-1)!.id : tabs.some((tab) => tab.id === value) ? value! : tabs[0]!.id;
  return (
    <Tabs value={active} onValueChange={setValue}>
      {/* Up to 5 labels: they scroll sideways instead of squeezing on a narrow phone. */}
      <GHScrollView horizontal showsHorizontalScrollIndicator={false}>
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              <Text>{String(tab.props.label)}</Text>
            </TabsTrigger>
          ))}
        </TabsList>
      </GHScrollView>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id}>
          <View className="gap-3 pt-1">{kids(tab.props.children).map(renderChild)}</View>
        </TabsContent>
      ))}
    </Tabs>
  );
}
