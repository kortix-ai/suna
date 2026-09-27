'use client';

import { Input } from '@/components/ui/input';
import { MAX_SESSION_NAME_LENGTH } from '@/features/workspace/project-sidebar/modal/use-rename-session';
import { useEffect, useRef, useState } from 'react';

/**
 * The name an inline edit should save, or `null` when it saves nothing.
 *
 * Empty and unchanged both return `null`: clearing the field and clicking away
 * is read as "never mind", not as "erase the name".
 */
export function resolveTitleCommit(draft: string, current: string): string | null {
  const next = draft.trim();
  if (!next || next === current.trim()) return null;
  return next;
}

interface SessionTitleInputProps {
  initialValue: string;
  ariaLabel: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/**
 * The session header's inline rename field. It replaces the name button in
 * place: Enter or blur saves, Escape discards. It mounts focused with the whole
 * name selected, so typing replaces it and an arrow key edits it.
 */
export function SessionTitleInput({
  initialValue,
  ariaLabel,
  onCommit,
  onCancel,
}: SessionTitleInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter saves and unmounts the field, and the unmount fires blur, which
  // would save a second time. The first exit wins.
  const finished = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = commit ? resolveTitleCommit(value, initialValue) : null;
    if (next) onCommit(next);
    else onCancel();
  };

  return (
    <Input
      ref={inputRef}
      variant="transparent"
      aria-label={ariaLabel}
      value={value}
      maxLength={MAX_SESSION_NAME_LENGTH}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      className="h-7 w-auto max-w-sm min-w-24 px-2.5 py-1 [field-sizing:content]"
    />
  );
}
