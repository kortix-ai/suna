import React from 'react';
import { ComposioUrlDetector } from './composio-url-detector';

export interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
}

export const StreamingText: React.FC<StreamingTextProps> = ({
  content,
  isStreaming = false,
}) => {
  return <ComposioUrlDetector content={content} isStreaming={isStreaming} />;
};
