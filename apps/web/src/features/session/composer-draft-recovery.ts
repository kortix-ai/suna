import type { AttachedFile, TrackedMention } from './session-chat-input';

export function mergeFailedSubmissionText(current: string, submitted: string): string {
  if (!current) return submitted;
  if (!submitted || current === submitted) return current;
  return `${submitted}\n\n${current}`;
}

function attachedFileKey(file: AttachedFile): string {
  return file.kind === 'local'
    ? `local:${file.localUrl}`
    : `remote:${file.url}:${file.filename}`;
}

export function mergeFailedSubmissionFiles(
  current: AttachedFile[],
  submitted: AttachedFile[],
): AttachedFile[] {
  const seen = new Set<string>();
  return [...submitted, ...current].filter((file) => {
    const key = attachedFileKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mentionKey(mention: TrackedMention): string {
  return `${mention.kind}:${mention.value ?? ''}:${mention.label}`;
}

export function mergeFailedSubmissionMentions(
  current: TrackedMention[],
  submitted: TrackedMention[],
): TrackedMention[] {
  const seen = new Set<string>();
  return [...submitted, ...current].filter((mention) => {
    const key = mentionKey(mention);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
