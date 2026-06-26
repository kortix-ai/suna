import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

/**
 * Slim sticky top bar used inside the inset, mirroring the Kortix session
 * site header. Hosts the sidebar trigger plus page-supplied title / actions.
 */
export function PageHeader({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'bg-background/80 sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur-md',
        className,
      )}
    >
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 !h-5" />
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </header>
  );
}
