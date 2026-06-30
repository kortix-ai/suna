'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { getManagedModel } from '@kortix/llm-catalog';

import { cn } from '@/lib/utils';

// One brand accent for the whole surface (Kortix is monochrome + a single
// accent). Per-model rainbow coloring was the "yellow-brown" noise — gone.
export const ACCENT = 'var(--kortix-blue)';

export function modelAccent(_id: string): string {
  return ACCENT;
}

export function modelLabel(id: string): string {
  const tail = id.split('/').pop() ?? id;
  return tail.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function displayModel(id: string): string {
  return getManagedModel(id)?.name ?? (id.split('/').pop() ?? id);
}

export function tint(accent: string, pct: number): string {
  return `color-mix(in oklch, ${accent} ${pct}%, transparent)`;
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      aria-label="Copy"
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-kortix-green" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function MetricBar({
  icon: Icon,
  value,
  pct,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  pct: number;
  accent: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3 shrink-0 text-muted-foreground" />
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-primary/[0.06]">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${Math.max(3, Math.min(100, pct))}%`, backgroundColor: accent }}
        />
      </div>
      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{value}</span>
    </div>
  );
}
