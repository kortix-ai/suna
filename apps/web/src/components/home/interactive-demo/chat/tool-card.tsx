import { Check, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { IconType } from 'react-icons/lib';

export function ToolCard({
  icon: Icon,
  tool,
  title,
  done,
  body,
}: {
  icon: LucideIcon | IconType;
  tool: string;
  title: string;
  done: boolean;
  body?: ReactNode;
}) {
  return (
    <div className="border-border/60 bg-card/50 overflow-hidden rounded-2xl border">
      <div className="border-border/40 bg-muted/30 flex items-center gap-2 border-b px-3 py-2 text-xs">
        <Icon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-foreground font-mono font-medium">{tool}</span>
        <span className="text-muted-foreground truncate">· {title}</span>
        {done ? (
          <Check className="ml-auto size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <span className="border-muted-foreground/40 border-t-foreground ml-auto size-3.5 shrink-0 animate-spin rounded-full border-[1.5px]" />
        )}
      </div>
      {body && <div className="text-muted-foreground px-3 py-2 text-xs">{body}</div>}
    </div>
  );
}
