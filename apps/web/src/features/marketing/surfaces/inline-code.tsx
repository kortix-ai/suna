import type { ReactNode } from 'react';

/** Copy with `backticked` commands: the commands in mono, the rest as is. */
export function InlineCode({ text }: { text: string }): ReactNode {
  return text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 ? (
      <code key={i} className="text-foreground font-mono">
        {part}
      </code>
    ) : (
      part
    ),
  );
}
