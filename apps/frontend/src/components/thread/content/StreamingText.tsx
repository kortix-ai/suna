import React from 'react';
import { ComposioUrlDetector } from './composio-url-detector';
import { InlineCheckout, extractInlineCheckout } from './InlineCheckout';
import { UpgradeButtonCTA, extractUpgradeButton } from './UpgradeButtonCTA';

export interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
}

export const StreamingText: React.FC<StreamingTextProps> = ({
  content,
  isStreaming = false,
}) => {
  // Extract inline checkout if present
  const { cleanContent: contentAfterCheckout, hasCheckout, options } = extractInlineCheckout(content);
  // Extract upgrade button if present
  const { cleanContent, hasUpgradeButton } = extractUpgradeButton(contentAfterCheckout);

  return (
    <>
      <ComposioUrlDetector content={cleanContent} isStreaming={isStreaming} />
      {hasUpgradeButton && !isStreaming && <UpgradeButtonCTA />}
      {hasCheckout && !isStreaming && <InlineCheckout options={options} />}
    </>
  );
};
