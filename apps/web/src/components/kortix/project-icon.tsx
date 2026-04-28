import { cn } from '@/lib/utils';

const PALETTE = [
  { border: 'border-red-500/30',     text: 'text-red-500',     bg: 'bg-red-500/20',     dot: 'bg-red-500' },
  { border: 'border-orange-500/30',  text: 'text-orange-500',  bg: 'bg-orange-500/20',  dot: 'bg-orange-500' },
  { border: 'border-amber-500/30',   text: 'text-amber-500',   bg: 'bg-amber-500/20',   dot: 'bg-amber-500' },
  { border: 'border-emerald-500/30', text: 'text-emerald-500', bg: 'bg-emerald-500/20', dot: 'bg-emerald-500' },
  { border: 'border-teal-500/30',    text: 'text-teal-500',    bg: 'bg-teal-500/20',    dot: 'bg-teal-500' },
  { border: 'border-cyan-500/30',    text: 'text-cyan-500',    bg: 'bg-cyan-500/20',    dot: 'bg-cyan-500' },
  { border: 'border-blue-500/30',    text: 'text-blue-500',    bg: 'bg-blue-500/20',    dot: 'bg-blue-500' },
  { border: 'border-indigo-500/30',  text: 'text-indigo-500',  bg: 'bg-indigo-500/20',  dot: 'bg-indigo-500' },
  { border: 'border-violet-500/30',  text: 'text-violet-500',  bg: 'bg-violet-500/20',  dot: 'bg-violet-500' },
  { border: 'border-fuchsia-500/30', text: 'text-fuchsia-500', bg: 'bg-fuchsia-500/20', dot: 'bg-fuchsia-500' },
  { border: 'border-rose-500/30',    text: 'text-rose-500',    bg: 'bg-rose-500/20',    dot: 'bg-rose-500' },
] as const;

export type ProjectColor = (typeof PALETTE)[number];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export function projectColor(id: string): ProjectColor {
  return PALETTE[Math.abs(hashString(id)) % PALETTE.length];
}

export function projectInitial(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, '').trim();
  return (cleaned[0] || '?').toUpperCase();
}

export type ProjectIconSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<ProjectIconSize, string> = {
  xs: 'size-5 text-[0.625rem]',
  sm: 'size-7 text-xs',
  md: 'size-9 text-sm',
  lg: 'size-12 text-base',
};

export function ProjectIcon({
  project,
  size = 'md',
  className,
}: {
  project: { id: string; name: string };
  size?: ProjectIconSize;
  className?: string;
}) {
  const color = projectColor(project.id);
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-xl border font-semibold tracking-tight',
        color.border,
        color.text,
        color.bg,
        SIZE_CLASS[size],
        className,
      )}
    >
      {projectInitial(project.name)}
    </div>
  );
}
