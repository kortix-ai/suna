'use client';

import { useRef, useState } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function SessionComposer({
  onSend,
  sending,
}: {
  onSend: (text: string) => void;
  sending: boolean;
}) {
  const [value, setValue] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  const submit = () => {
    const text = value.trim();
    if (!text || sending) return;
    onSend(text);
    setValue('');
  };

  return (
    <div className="from-background pointer-events-none sticky bottom-0 -mx-4 bg-gradient-to-t to-transparent px-4 pt-8 pb-4">
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="border-border bg-card focus-within:border-foreground/30 focus-within:ring-foreground/10 pointer-events-auto mx-auto flex w-full max-w-3xl items-end gap-2 overflow-hidden rounded-2xl border p-2 shadow-lg transition-all focus-within:ring-4"
      >
        <Textarea
          name="prompt"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Reply to the agent…"
          minHeight={24}
          maxHeight={160}
          className="rounded-none border-0 bg-transparent px-2 py-1.5 text-sm shadow-none focus:border-0 focus-visible:ring-0 dark:bg-transparent"
        />
        <Button
          type="submit"
          size="icon-sm"
          className="size-8 rounded-lg"
          disabled={!value.trim() || sending}
          aria-label="Send message"
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </Button>
      </form>
    </div>
  );
}
