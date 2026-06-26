import {
  FilePlus2,
  FileText,
  FolderTree,
  Globe,
  ListChecks,
  type LucideIcon,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import { StatusBadge, StatusDot } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { toStatusTone } from './types';

interface ToolMeta {
  icon: LucideIcon;
  label: string;
}

/** Maps an OpenCode-style tool name to an icon + human label. */
export function getToolMeta(rawName: string): ToolMeta {
  const name = rawName.toLowerCase().replace(/^workspace:/, '');
  if (/(^|_|-)read|cat|view/.test(name)) return { icon: FileText, label: 'Read' };
  if (/write|create|add/.test(name)) return { icon: FilePlus2, label: 'Write' };
  if (/edit|patch|update|modify/.test(name)) return { icon: Pencil, label: 'Edit' };
  if (/bash|shell|exec|run|command/.test(name)) return { icon: Terminal, label: 'Terminal' };
  if (/grep|search|find/.test(name)) return { icon: Search, label: 'Search' };
  if (/list|ls|tree|glob/.test(name)) return { icon: FolderTree, label: 'List files' };
  if (/web|fetch|http|browse|url/.test(name)) return { icon: Globe, label: 'Web' };
  if (/todo|task|plan|checklist/.test(name)) return { icon: ListChecks, label: 'Plan' };
  return { icon: Wrench, label: 'Tool' };
}

export function prettyName(rawName: string): string {
  return rawName.replace(/^workspace:/, '').replace(/[_-]/g, ' ');
}

export function ToolCard({
  tool,
  status,
  text,
}: {
  tool: string;
  status?: string;
  text: string;
}) {
  const meta = getToolMeta(tool);
  const Icon = meta.icon;
  const tone = toStatusTone(status);
  const running = (status ?? '').toLowerCase() === 'running';

  return (
    <div className="border-border bg-card rounded-xl border">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span className="bg-muted text-muted-foreground grid size-7 shrink-0 place-items-center rounded-md">
          <Icon className="size-3.5" />
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="text-sm font-medium">{meta.label}</span>
          <span className="text-muted-foreground truncate font-mono text-xs">
            {prettyName(tool)}
          </span>
        </div>
        <StatusBadge tone={tone} className="shrink-0 capitalize">
          <StatusDot tone={tone} pulse={running} />
          {status ?? 'done'}
        </StatusBadge>
      </div>
      {text.trim() ? (
        <div className="border-border/60 border-t px-3 py-2">
          <p className={cn('text-muted-foreground text-xs leading-relaxed')}>{text}</p>
        </div>
      ) : null}
    </div>
  );
}
