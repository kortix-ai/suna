import React from 'react';
import { ComposioUrlDetector } from './composio-url-detector';
import { UpgradeCTA, extractUpgradeCTA } from './UpgradeCTA';
import { InlineCheckout, extractInlineCheckout } from './InlineCheckout';

export interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
}

export const StreamingText: React.FC<StreamingTextProps> = ({
  content,
  isStreaming = false,
}) => {
  // Extract upgrade CTA if present
  const { cleanContent: contentAfterCTA, hasCTA } = extractUpgradeCTA(content);
  // Extract inline checkout if present
  const { cleanContent, hasCheckout, options } = extractInlineCheckout(contentAfterCTA);

  return (
    <>
      <ComposioUrlDetector content={cleanContent} isStreaming={isStreaming} />
      {hasCheckout && !isStreaming && <InlineCheckout options={options} />}
      {hasCTA && !hasCheckout && !isStreaming && <UpgradeCTA />}
    </>
  );
};
