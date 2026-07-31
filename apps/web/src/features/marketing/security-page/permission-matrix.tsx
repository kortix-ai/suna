import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { identity } from './content';

/**
 * The permission model in one picture: a principal, an action, a resource type.
 * Both lists are the real ones — the resource types are exactly the set the API
 * accepts, and "service account" sits beside "person" because the engine really
 * does treat it as a first-class principal rather than a token borrowing
 * somebody's reach.
 *
 * Drawn from divs and mono type so it scales, themes, and stays readable as a
 * list when a screen reader flattens it.
 */

function Cell({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={cn('border-border flex flex-1 flex-col p-5 sm:p-7', className)}>
      <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
        {label}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function Chip({ children, strong }: { children: ReactNode; strong?: boolean }): ReactNode {
  return (
    <span
      className={
        strong
          ? 'border-foreground/25 bg-foreground/5 text-foreground rounded-sm border px-2.5 py-1 font-mono text-[11px]'
          : 'border-border text-muted-foreground rounded-sm border px-2.5 py-1 font-mono text-[11px]'
      }
    >
      {children}
    </span>
  );
}

export function PermissionMatrix(): ReactNode {
  return (
    <div className="border-border bg-card overflow-hidden rounded-sm border">
      <div className="grid lg:grid-cols-[1fr_auto_1fr]">
        <Cell label="principal">
          {identity.matrix.principals.map((p) => (
            <Chip key={p} strong>
              {p}
            </Chip>
          ))}
        </Cell>

        {/* the joint: what a policy actually is */}
        <div className="border-border relative flex items-center justify-center border-t px-5 py-4 lg:border-x lg:border-t-0 lg:px-8">
          <span className="text-muted-foreground/60 font-mono text-[11px] tracking-widest uppercase">
            may
          </span>
        </div>

        <Cell label="resource type" className="border-t lg:border-t-0">
          {identity.matrix.resources.map((r) => (
            <Chip key={r}>{r}</Chip>
          ))}
        </Cell>
      </div>

      <p className="border-border text-muted-foreground border-t px-5 py-4 text-sm leading-relaxed sm:px-7">
        {identity.matrix.caption}
      </p>
    </div>
  );
}
