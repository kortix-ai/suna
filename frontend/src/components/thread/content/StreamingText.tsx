import React from 'react';
import { ComposioUrlDetector } from './composio-url-detector';

interface StreamingTextProps {
  content: string;
}

export const StreamingText: React.FC<StreamingTextProps> = ({
  content,
}) => {
  if (!content) {
    return null;
  }

  return (
    <div className="break-words overflow-hidden">
      <ComposioUrlDetector content={content} />
    </div>
  );
};
