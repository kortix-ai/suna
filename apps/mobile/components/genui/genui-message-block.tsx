import { Component, memo, type ReactNode } from 'react';
import { View } from 'react-native';
import { GenuiBlock } from '@kortix/sdk/genui/react';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';

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

/** The SDK's note for a block it cannot show, in its muted small style. */
function UnavailableNote() {
  const { t } = useTranslation();
  return <Text variant="muted">{t('genui.unavailable', 'This content could not be displayed.')}</Text>;
}

/**
 * One block's own error boundary (web's `GenuiFenceBoundary`). The SDK already turns a component's throw into the
 * block's markdown; this catches what escapes it (the parser, the markdown renderer), so one block fails, not the
 * message. A new `source` gives the block a fresh try.
 */
class BlockBoundary extends Component<{ source: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  // Not a `key`: that would remount the block (and lose its parser and host state) on every streamed token.
  override componentDidUpdate(previous: { source: string }) {
    if (this.state.failed && previous.source !== this.props.source) this.setState({ failed: false });
  }
  override render() {
    return this.state.failed ? <UnavailableNote /> : this.props.children;
  }
}

/** One ```openui fence of a chat message, rendered with the mobile components (or as markdown when turned off). */
export const GenuiMessageBlock = memo(function GenuiMessageBlock({ code, version, isStreaming, renderMarkdown }: GenuiMessageBlockProps) {
  const enabled = useGenuiStore((s) => s.enabled);
  return (
    <View className="my-4">
      <BlockBoundary source={code}>
        <GenuiBlock
          code={code}
          version={version}
          streaming={isStreaming}
          enabled={enabled}
          components={mobileGenuiComponents}
          renderMarkdown={renderMarkdown}
          renderPending={GenuiPending}
        />
      </BlockBoundary>
    </View>
  );
});
