import { View } from 'react-native';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { AccordionItem } from '@/components/kortix/accordion';
import { Separator } from '@/components/ui/separator';

import { kids } from './layout';

/** Every item starts collapsed and opens on its own, as on web. */
export function GenuiAccordion({ props, renderChild }: GenuiComponentProps) {
  return (
    <View className="overflow-hidden rounded-2xl bg-card">
      {kids(props.items).map((item, index) => (
        <View key={item.id}>
          {index > 0 ? <Separator /> : null}
          <AccordionItem title={String(item.props.title)}>{kids(item.props.children).map(renderChild)}</AccordionItem>
        </View>
      ))}
    </View>
  );
}
