'use client';

/**
 * <InlineTextEditor> — seamless inline text editing.
 *
 * Always mounted as a <textarea> styled to look identical to static text.
 * No Edit button, no Save/Cancel buttons. Auto-grows with content, commits
 * on blur, reverts to last committed value on Escape.
 */

import { useRef, useEffect, useLayoutEffect } from 'react';
import { cn } from '@/lib/utils';

export interface InlineTextEditorProps {
  value: string;
  onChange: (v: string) => void;
  /** Called when the user finishes editing (blur) */
  onCommit: () => void;
  placeholder?: string;
  className?: string;
}

export function InlineTextEditor({
  value,
  onChange,
  onCommit,
  placeholder,
  className,
}: InlineTextEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastCommittedRef = useRef(value);

  // Snapshot committed value on mount + when parent resets us
  useEffect(() => {
    lastCommittedRef.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-grow
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        lastCommittedRef.current = value;
        onCommit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onChange(lastCommittedRef.current);
          ref.current?.blur();
        }
      }}
      placeholder={placeholder}
      rows={1}
      spellCheck
      className={cn(
        'w-full resize-none overflow-hidden',
        'bg-transparent border-0 outline-none p-0 m-0',
        'text-[14px] text-foreground/85 leading-[1.7] tracking-normal',
        'placeholder:text-muted-foreground/40 placeholder:italic',
        'focus:bg-muted/10 focus:ring-0 transition-colors rounded-md',
        'px-3 -mx-3 py-1',
        className,
      )}
    />
  );
}
