import { cn } from '@/lib/utils';

const ICON_HUES = [12, 30, 50, 90, 145, 195, 230, 265, 305, 340] as const;

export function projectAccent(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const hue = ICON_HUES[Math.abs(hash) % ICON_HUES.length];
  return `oklch(0.62 0.14 ${hue})`;
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
  const accent = projectAccent(project.id);
  const initial = projectInitial(project.name);
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg font-semibold tracking-tight text-white ring-1 ring-inset ring-white/10',
        SIZE_CLASS[size],
        className,
      )}
      style={{ backgroundColor: accent }}
    >
      {initial}
    </div>
  );
}
