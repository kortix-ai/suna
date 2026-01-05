import React, { useMemo } from 'react';
import { processUnicodeContent } from '@/components/file-editors';

interface JsonRendererProps {
  content: string;
  className?: string;
}

export function JsonRenderer({ content, className = '' }: JsonRendererProps) {
  const formattedJson = useMemo(() => {
    const processed = processUnicodeContent(content);
    try {
      const parsed = JSON.parse(processed);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // If parsing fails, return the processed content as-is
      return processed;
    }
  }, [content]);

  return (
    <div className={`h-full w-full overflow-auto px-6 py-4 ${className}`}>
      <pre className="text-xs font-mono text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words">
        {formattedJson}
      </pre>
    </div>
  );
}

