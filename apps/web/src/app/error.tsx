'use client';

import { Button } from '@/components/ui/button';
import Link from 'next/link';

export default function Error({
  error,
}: {
  error: Error & { digest?: string; statusCode?: number };
}) {
  const handleReset = () => {
    try {
      window.location.reload();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="flex max-w-xl flex-col items-center justify-center space-y-6 text-center">
        <svg
          width="24"
          height="24"
          className="size-10"
          fill="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M2.25 12.044v6.517c0 .764.308 1.57.8 2.127.501.567 1.354 1.012 2.287.543.696-.35 1.275-.363 1.746-.047 1.126.755 2.708.755 3.834 0 .345-.23.607-.308.825-.31.218-.001.485.072.84.31 1.127.755 2.709.755 3.835 0 .213-.142.58-.237 1.044-.226.454.01.898.12 1.202.273.933.469 1.786.024 2.287-.543.492-.557.8-1.363.8-2.126v-6.518c0-5.405-4.362-9.794-9.75-9.794s-9.75 4.389-9.75 9.794m6.303 3.354A5.77 5.77 0 0 1 12 14.25c1.285 0 2.474.427 3.447 1.148a.75.75 0 0 1-.894 1.204A4.27 4.27 0 0 0 12 15.75a4.27 4.27 0 0 0-2.553.852.75.75 0 1 1-.894-1.204M10.25 10v.5a.75.75 0 1 1-1.5 0V10a.75.75 0 1 1 1.5 0m4.25-.75a.75.75 0 0 1 .75.75v.5a.75.75 0 1 1-1.5 0V10a.75.75 0 0 1 .75-.75" />
        </svg>

        <div className="space-y-2">
          <h1 className="text-base-900 text-base sm:text-lg md:text-xl">Something went wrong</h1>

          {error.message && <p className="text-base-500 text-base text-balance">{error.message}</p>}
        </div>

        <div className="flex items-center gap-2">
          <Button asChild size="sm">
            <Link href="/">Home</Link>
          </Button>
          <Button onClick={handleReset} size="sm" variant="secondary">
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
