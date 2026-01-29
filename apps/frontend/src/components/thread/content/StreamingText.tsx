import React from 'react';
import { ComposioUrlDetector } from './composio-url-detector';
import { InlineCheckout, extractInlineCheckout } from './InlineCheckout';

export interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
}

export const StreamingText: React.FC<StreamingTextProps> = ({
  content,
  isStreaming = false,
}) => {
  // Extract inline checkout if present
  const { cleanContent, hasCheckout, options } = extractInlineCheckout(content);

  return (
    <>
      <ComposioUrlDetector content={cleanContent} isStreaming={isStreaming} />
      {hasCheckout && !isStreaming && <InlineCheckout options={options} />}
    </>
  );
};
