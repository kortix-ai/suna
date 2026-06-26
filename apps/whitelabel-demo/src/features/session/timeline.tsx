import { FileText } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { Markdown } from '@/components/markdown';
import { cn } from '@/lib/utils';
import { ToolCard } from './tool-card';
import type { TimelineItem } from './types';

export function Timeline({ items, working }: { items: TimelineItem[]; working?: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      {items.map((item) => (
        <TimelineRow key={item.id} item={item} />
      ))}
      {working ? <WorkingIndicator /> : null}
    </div>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-secondary text-secondary-foreground max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
          {item.text}
        </div>
      </div>
    );
  }

  if (item.kind === 'tool') {
    return (
      <div className="pl-0 sm:pl-9">
        <ToolCard tool={item.tool} status={item.status} text={item.text} />
      </div>
    );
  }

  // assistant
  return (
    <div className="flex gap-3">
      <BrandMark className="mt-0.5 size-7 shrink-0 rounded-lg" glyphClassName="size-3.5" />
      <div className="min-w-0 flex-1 pt-0.5">
        {item.error ? (
          <div className="border-destructive/30 bg-destructive/10 text-destructive mb-2 rounded-lg border px-3 py-2 text-sm">
            {item.error.message ?? item.error.name ?? 'The agent reported an error.'}
          </div>
        ) : null}
        <Markdown text={item.text} />
        {item.reasoningOmitted ? (
          <p className="text-muted-foreground mt-1 text-xs italic">Reasoning hidden</p>
        ) : null}
        {item.files?.length ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {item.files.map((file) => (
              <span
                key={file}
                className="border-border bg-muted/40 text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs"
              >
                <FileText className="size-3" />
                {file}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkingIndicator() {
  return (
    <div className="flex items-center gap-3">
      <BrandMark className="size-7 shrink-0 rounded-lg" glyphClassName="size-3.5" />
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn('bg-muted-foreground/50 size-1.5 animate-bounce rounded-full')}
            style={{ animationDelay: `${i * 120}ms`, animationDuration: '900ms' }}
          />
        ))}
      </div>
    </div>
  );
}
