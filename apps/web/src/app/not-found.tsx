import { Button } from '@/components/ui/button';
import Link from 'next/link';

const NotFound = () => {
  return (
    <section>
      <div className="flex h-dvh flex-col items-center justify-center gap-12 text-center">
        <div className="mx-auto flex max-w-xl flex-col items-center justify-center space-y-6 px-6">
          <svg
            width="24"
            height="24"
            fill="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
            className="size-10"
          >
            <path d="M2.25 12.044v6.517c0 .764.308 1.57.8 2.127.501.567 1.354 1.012 2.287.543.696-.35 1.275-.363 1.746-.047 1.126.755 2.708.755 3.834 0 .345-.23.607-.308.825-.31.218-.001.485.072.84.31 1.127.755 2.709.755 3.835 0 .213-.142.58-.237 1.044-.226.454.01.898.12 1.202.273.933.469 1.786.024 2.287-.543.492-.557.8-1.363.8-2.126v-6.518c0-5.405-4.362-9.794-9.75-9.794s-9.75 4.389-9.75 9.794m14.516.934a.75.75 0 0 1-.017 1.06 8 8 0 0 1-.536.476l.218.445a2.25 2.25 0 0 1-4.039 1.983l-.273-.557a8.9 8.9 0 0 1-3.801-.087.75.75 0 0 1 .364-1.455c1.13.283 2.429.287 3.746-.066s2.44-1.005 3.278-1.816a.75.75 0 0 1 1.06.017m-3.027 3.303-.147-.299q.721-.26 1.366-.62l.127.258a.75.75 0 0 1-1.346.66M9.329 10l.103.489a.75.75 0 1 1-1.467.311l-.104-.489A.75.75 0 1 1 9.328 10m4-1.618a.75.75 0 0 1 .89.578l.104.489a.75.75 0 1 1-1.467.312l-.104-.49a.75.75 0 0 1 .578-.889" />
          </svg>

          <div className="space-y-1">
            <h1 className="text-base-900 text-base sm:text-lg md:text-xl">404 Page not found</h1>
            <p className="text-base-500 text-base text-balance">
              The page you are looking for does not exist.
            </p>
          </div>
          <div className="grid w-full grid-cols-1 gap-2 lg:grid-cols-2">
            <Button asChild variant="secondary" className="w-full">
              <Link href="/">Go back to home</Link>
            </Button>
            <Button asChild className="w-full">
              <Link href="/docs">Documentation</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
};

export default NotFound;
