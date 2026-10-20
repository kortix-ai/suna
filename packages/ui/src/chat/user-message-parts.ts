import type { ClassifiedPart } from '@kortix/sdk';

/** Keep user text plain; render every other part with the transcript renderers. */
export function userMessageParts(parts: readonly ClassifiedPart[]) {
  return {
    text: parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim(),
    parts: parts.filter((part) => part.kind !== 'text'),
  };
}
