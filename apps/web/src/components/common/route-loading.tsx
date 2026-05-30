import { KortixLoader } from '@/components/ui/kortix-loader';

/**
 * Shared fallback for Next.js route-segment `loading.tsx` files — a centered
 * spinner shown during navigation/streaming instead of a blank frame.
 */
export function RouteLoadingFallback() {
  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center">
      <KortixLoader size="large" />
    </div>
  );
}
