'use client';

import { useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ArrowUp, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea, type AutosizeTextAreaRef } from '@/components/ui/textarea';

import { createSessionAction } from '@/lib/actions';

const MODES = ['Build', 'Inspect', 'Explain'] as const;

const SUGGESTIONS = [
  'Inspect the workspace and draft an implementation plan.',
  'Add a concise README section that explains this project.',
  'Create a small checklist artifact for the next engineer.',
  'Audit the codebase and list the top 3 risks.',
];

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="icon-sm"
      className="size-8 rounded-lg"
      disabled={pending}
      aria-label="Start session"
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
    </Button>
  );
}

export function HomeComposer() {
  const [mode, setMode] = useState<(typeof MODES)[number]>('Build');
  const [value, setValue] = useState('');
  const textareaRef = useRef<AutosizeTextAreaRef>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const fill = (text: string) => {
    setValue(text);
    textareaRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        ref={formRef}
        action={createSessionAction}
        className="border-border bg-card focus-within:border-foreground/30 focus-within:ring-foreground/10 overflow-hidden rounded-2xl border shadow-sm transition-all focus-within:ring-4"
      >
        <input type="hidden" name="mode" value={mode} />
        <Textarea
          ref={textareaRef}
          name="prompt"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
          placeholder="Ask the agent to build, inspect, explain, or change something…"
          required
          minHeight={92}
          maxHeight={240}
          className="rounded-none border-0 bg-transparent px-4 py-3.5 text-[15px] shadow-none focus:border-0 focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="border-border/70 flex items-center justify-between gap-2 border-t px-2.5 py-2">
          <Select value={mode} onValueChange={(v) => setMode(v as (typeof MODES)[number])}>
            <SelectTrigger
              size="sm"
              className="hover:bg-accent h-8 w-auto gap-1.5 rounded-lg border-none bg-transparent shadow-none"
            >
              <Sparkles className="size-3.5 opacity-70" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground hidden text-xs sm:inline">
              <kbd className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">⌘</kbd>
              <kbd className="bg-muted ml-0.5 rounded px-1 py-0.5 font-mono text-[10px]">↵</kbd>
              <span className="ml-1.5">to start</span>
            </span>
            <SubmitButton />
          </div>
        </div>
      </form>

      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => fill(s)}
            className="border-border bg-card text-muted-foreground hover:text-foreground hover:border-foreground/20 rounded-full border px-3 py-1.5 text-xs transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
