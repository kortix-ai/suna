import React from 'react';
import { ComposioUrlDetector } from './composio-url-detector';
import { UpgradeCTA, extractUpgradeCTA } from './UpgradeCTA';

export interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
}

export const StreamingText: React.FC<StreamingTextProps> = ({
  content,
  isStreaming = false,
}) => {
  // Extract upgrade CTA if present
  const { cleanContent, hasCTA } = extractUpgradeCTA(content);

  return (
    <>
      <ComposioUrlDetector content={cleanContent} isStreaming={isStreaming} />
      {hasCTA && !isStreaming && <UpgradeCTA />}
    </>
  );
};
