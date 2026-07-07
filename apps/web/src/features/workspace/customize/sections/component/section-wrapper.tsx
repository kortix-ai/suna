import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type React from 'react';

type Props = {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  docs?: string;
  className?: string;
  /**
   * Fixed-shell mode. The header becomes a non-scrolling top bar and `children`
   * fill the remaining height to own their own scroll — used by the master-detail
   * split, where the section header, list, and aside stay put and only the
   * content pane scrolls. Default is the single scrolling column.
   */
  fill?: boolean;
};

const CustomizeSectionWrapper = ({
  title,
  description,
  children,
  action,
  docs,
  className,
  fill,
}: Props) => {
  const heading = (
    <div className="space-y-1">
      <h2 className="text-foreground text-xl font-medium">{title}</h2>
      {description || docs ? (
        <span className="flex items-center gap-1">
          {description ? (
            <p className="text-muted-foreground text-sm text-balance">{description}</p>
          ) : null}
          {docs && (
            <Button variant="transparent" className="m-0 p-0" asChild>
              <Link href={docs} target="_blank" rel="noopener noreferrer">
                Learn more.
              </Link>
            </Button>
          )}
        </span>
      ) : null}
    </div>
  );

  if (fill) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="border-border/60 flex shrink-0 flex-col gap-2 border-b px-4 py-2 sm:flex-row sm:items-center sm:justify-between">
          {heading}
          {action ? <div className="mt-2 shrink-0 sm:mt-0">{action}</div> : null}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">{children}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn('mx-auto w-full max-w-3xl space-y-5 px-4 py-10 pb-20 lg:py-20', className)}
        >
          <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            {heading}
            {action ? <div className="mt-2 shrink-0 sm:mt-0">{action}</div> : null}
          </header>

          {children}
        </div>
      </div>
    </div>
  );
};

export default CustomizeSectionWrapper;
