import React from 'react';
import { ComposioUrlDetector } from './composio-url-detector';
import { useSmoothText } from '@/hooks/messages';

interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
}

export const StreamingText: React.FC<StreamingTextProps> = ({
  content,
  isStreaming = true,
}) => {
  // STREAMING OPTIMIZATION: Display content immediately without typewriter animation
  // This ensures real-time streaming without artificial delays
  if (!content) {
    return null;
  }

  return (
    <div className="break-words overflow-hidden">
      <ComposioUrlDetector content={content} isStreaming={isStreaming} />
    </div>
  );
};
