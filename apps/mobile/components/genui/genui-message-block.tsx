import { memo, type ReactNode } from 'react';
import { View } from 'react-native';
import { GenuiBlock } from '@kortix/sdk/genui/react';

import { useGenuiStore } from '@/stores/genui-store';

import { GenuiPending, mobileGenuiComponents } from './components';

export interface GenuiMessageBlockProps {
  code: string;
  version: number;
  isStreaming: boolean;
  /**
   * The markdown renderer of the message (passed in to avoid an import cycle with selectable-markdown).
   * Must be stable: `GenuiBlock` re-renders its markdown parts when it changes.
   */
  renderMarkdown: (markdown: string) => ReactNode;
}

/** One ```openui fence of a chat message, rendered with the mobile components (or as markdown when turned off). */
export const GenuiMessageBlock = memo(function GenuiMessageBlock({ code, version, isStreaming, renderMarkdown }: GenuiMessageBlockProps) {
  const enabled = useGenuiStore((s) => s.enabled);
  return (
    <View className="my-2">
      <GenuiBlock
        code={code}
        version={version}
        streaming={isStreaming}
        enabled={enabled}
        components={mobileGenuiComponents}
        renderMarkdown={renderMarkdown}
        renderPending={GenuiPending}
      />
    </View>
  );
});
