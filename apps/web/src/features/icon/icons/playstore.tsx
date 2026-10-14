'use client';

import { cn } from '@/lib/utils';

/** Google Play's own brand colours, a third-party mark: never theme tokens. */
const GOOGLE_PLAY = {
  red: '#EB3131',
  yellow: '#F6B60B',
  blue: '#5778C5',
  green: '#3BAD49',
} as const;

/** The Google Play mark, in its own four colours. */
export const PlayStore = ({ className, ...props }: React.ComponentProps<'svg'>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="13.296 9.522 30.687 34.293"
    width="16"
    height="16"
    aria-hidden="true"
    className={cn('size-4 shrink-0', className)}
    {...props}
  >
    <path
      d="m27.622 25.899-14.194 15.066c5.34e-4 0.003 0.002 0.006 0.002 0.009 0.435 1.636 1.93 2.841 3.703 2.841 0.709 0 1.375-0.192 1.945-0.528l0.045-0.027 15.978-9.22-7.479-8.141"
      fill={GOOGLE_PLAY.red}
    />
    <path
      d="m41.983 23.334-0.014-0.009-6.898-3.999-7.772 6.916 7.799 7.798 6.862-3.959c1.203-0.649 2.02-1.918 2.02-3.38 0-1.452-0.806-2.714-1.997-3.365"
      fill={GOOGLE_PLAY.yellow}
    />
    <path
      d="M13.426 12.37C13.341 12.685 13.296 13.014 13.296 13.357L13.296 39.98C13.296 40.322 13.34 40.652 13.427 40.966L28.111 26.285L13.427 12.371"
      fill={GOOGLE_PLAY.blue}
    />
    <path
      d="m27.727 26.668 7.347-7.345-15.96-9.253c-0.58-0.347-1.257-0.548-1.982-0.548-1.773 0-3.27 1.207-3.705 2.845-5.34e-4 0.002-5.34e-4 0.003-5.34e-4 0.004l14.3 14.298"
      fill={GOOGLE_PLAY.green}
    />
  </svg>
);
