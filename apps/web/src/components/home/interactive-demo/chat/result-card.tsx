import { Check, type LucideIcon } from 'lucide-react';
import { PiCheckCircleFill } from 'react-icons/pi';

export function FileResult({
  name,
  meta,
  icon: Icon,
  action: Action,
}: {
  name: string;
  meta: string;
  icon: LucideIcon;
  action: LucideIcon;
}) {
  return (
    <div className="border-border/60 bg-card mt-3 flex items-center gap-3 rounded-md border p-3">
      <span className="bg-foreground/6 text-foreground flex size-9 items-center justify-center rounded-lg">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-sm font-medium">{name}</div>
        <div className="text-muted-foreground text-xs">{meta}</div>
      </div>
      <span className="text-background/90 bg-primary/90 inline-flex size-8 items-center justify-center rounded-md border">
        <Action className="size-4" />
      </span>
    </div>
  );
}

export function ListResult({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="border-border/60 bg-card mt-3 overflow-hidden rounded-md border">
      <div className="border-border/60 bg-muted/30 text-foreground border-b px-3 py-2 text-xs font-medium">
        {title}
      </div>
      <ul className="divide-border/50 divide-y">
        {items.map((it) => (
          <li
            key={it}
            className="text-muted-foreground flex items-center gap-2 px-3 py-2 font-mono text-xs"
          >
            <Check className="size-3 shrink-0 text-emerald-500" />
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SentResult({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="border-border/60 bg-card mt-3 flex items-center gap-3 rounded-md border p-3">
      <PiCheckCircleFill className="text-kortix-green size-5 shrink-0" />
      <div className="min-w-0">
        <div className="text-foreground text-sm font-medium">{title}</div>
        <div className="text-muted-foreground text-xs">{meta}</div>
      </div>
    </div>
  );
}
