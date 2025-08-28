import React from 'react';
import { ComposioUrlDetector } from './composio-url-detector';

interface StreamingTextProps {
  content: string;
  className?: string;
}

export const StreamingText: React.FC<StreamingTextProps> = ({
  content,
  className = "text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3 break-words overflow-wrap-anywhere"
}) => {
  if (!content) {
    return null;
  }

  return (
    <div className="prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3 break-words overflow-hidden">
      <ComposioUrlDetector content={content} className={className} />
    </div>
  );
};
