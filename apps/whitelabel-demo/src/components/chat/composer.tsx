'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ArrowUp, Square } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

/**
 * Chat composer as a self-contained input card. Enter sends, Shift+Enter
 * newlines. While the agent is busy the send button becomes a stop button. The
 * `toolbar` slot (e.g. the model picker) sits in the footer.
 */
export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  placeholder = 'Message the agent…',
  toolbar,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  toolbar?: ReactNode;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
    requestAnimationFrame(grow);
  };

  return (
    <div
      className={cn(
        'rounded-2xl border border-border bg-card shadow-sm transition-colors focus-within:border-ring/60',
        disabled && 'opacity-70',
      )}
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          grow();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        className="max-h-52 min-h-[24px] w-full resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground scrollbar-thin"
      />
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
        <div className="min-w-0">{toolbar}</div>
        {busy ? (
          <Button size="icon" variant="secondary" onClick={onStop} aria-label="Stop" className="size-8 rounded-full">
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={submit}
            disabled={!value.trim() || disabled}
            aria-label="Send"
            className="size-8 rounded-full"
          >
            <ArrowUp className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
