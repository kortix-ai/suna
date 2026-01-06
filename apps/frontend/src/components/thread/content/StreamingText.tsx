import React from 'react';
import { ComposioUrlDetector } from './composio-url-detector';
import { useSmoothText } from '@/hooks/messages/useSmoothText';

interface StreamingTextProps {
  content: string;
}

export const StreamingText: React.FC<StreamingTextProps> = ({
  content,
}) => {
  // Apply smooth typewriter effect: reveal text at ~50 chars/second
  const smoothContent = useSmoothText(content, 50, true);

  if (!smoothContent) {
    return null;
  }

  return (
    <div className="break-words overflow-hidden">
      <ComposioUrlDetector content={smoothContent.text} />
    </div>
  );
};
