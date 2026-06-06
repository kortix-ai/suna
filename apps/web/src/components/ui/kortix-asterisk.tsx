import { cn } from '@/lib/utils';

export const KORTIX_BULLET_GRADIENT =
  'linear-gradient(to bottom, var(--kortix-red), var(--kortix-green), var(--kortix-blue), var(--kortix-yellow), var(--kortix-purple), var(--kortix-red))';

const ASTERISK_ARMS = [
  { className: 'z-10' },
  { className: 'z-20 rotate-90' },
  { className: 'z-30 rotate-45' },
  { className: 'z-40 -rotate-45' },
] as const;

export function KortixAsterisk({ index,parentClass }: { index: number,parentClass?: string }) {
  return (
    <div className={cn("relative mt-1 flex size-6 shrink-0 items-center justify-center",parentClass)}>
      {ASTERISK_ARMS.map(({ className }, armIndex) => (
        <div
          key={armIndex}
          className={cn(
            'animate-kortix-bullet-flow absolute h-3.5 w-px shrink-0 rounded-full bg-[length:100%_300%]',
            className,
          )}
          style={{
            backgroundImage: KORTIX_BULLET_GRADIENT,
            animationDelay: `${index * 0.4 + armIndex * 0.08}s`,
          }}
        />
      ))}
    </div>
  );
}
