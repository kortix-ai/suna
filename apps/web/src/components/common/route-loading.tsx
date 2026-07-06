import { KortixHyperLogo } from '@/components/ui/marketing/kortix-hyper-logo';

/**
 * Shared fallback for Next.js route-segment `loading.tsx` files — the Kortix
 * ASCII logo loader, shown during navigation/streaming instead of a blank frame.
 */
export function RouteLoadingFallback() {
  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center">
      <KortixHyperLogo size={72} startOnView={false} loop className="text-foreground" />
    </div>
  );
}
