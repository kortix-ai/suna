'use client';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Sparkles } from 'lucide-react';

// AUTO lives outside the provider groups in the model picker — a standalone on/off
// control rendered above every provider. `auto` is a synthetic managed entry (not a
// real upstream model): turning it on selects it; the whole manual provider list is
// then hidden until the user expands it. Pure presentation — the picker owns the
// state and the toggle semantics (see ModelSelector.toggleAuto).
export function AutoModelToggle({ autoOn, onToggle }: { autoOn: boolean; onToggle: () => void }) {
  return (
    <div className="p-1.5">
      {/* biome-ignore lint/a11y/useSemanticElements: the clickable row wraps a Switch (itself a <button>), which can't legally nest inside a real <button> */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className={cn(
          'group flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors duration-200 select-none',
          autoOn ? 'bg-primary/[0.07]' : 'hover:bg-foreground/[0.04]',
        )}
      >
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-200',
            autoOn
              ? 'bg-primary/15 text-primary'
              : 'bg-foreground/[0.06] text-foreground/70 group-hover:text-foreground',
          )}
        >
          <Sparkles className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-[13px] leading-tight font-medium">Auto</div>
          <p className="text-muted-foreground/70 mt-0.5 text-xs leading-tight">
            Best model, chosen for each task
          </p>
        </div>
        <Switch
          checked={autoOn}
          onCheckedChange={onToggle}
          tabIndex={-1}
          className="pointer-events-none shrink-0"
        />
      </div>
    </div>
  );
}
