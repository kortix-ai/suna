'use client';

import { Button, Textarea } from '@/components/ui';
import { ArrowUp, Square } from 'lucide-react';
import { useState } from 'react';

/**
 * Chat composer. Enter sends, Shift+Enter newlines. While the agent is busy the
 * send button becomes a stop button wired to `onStop`.
 */
export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  placeholder = 'Message the agent…',
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState('');

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
  };

  return (
    <div className="relative">
      <Textarea
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        className="max-h-48 min-h-[52px] py-3.5 pr-14"
      />
      <div className="absolute bottom-2.5 right-2.5">
        {busy ? (
          <Button size="icon" variant="outline" onClick={onStop} aria-label="Stop">
            <Square className="size-4 fill-current" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={submit}
            disabled={!value.trim() || disabled}
            aria-label="Send"
          >
            <ArrowUp className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
