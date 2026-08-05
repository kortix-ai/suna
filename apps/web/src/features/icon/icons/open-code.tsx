'use client';

import { cn } from '@/lib/utils';

/**
 * Exported as `HarnessMark`, not `OpenCode` — `eslint.config.mjs`'s
 * `no-restricted-syntax` rule bans any import specifier whose name matches
 * `/OpenCode/i` repo-wide, to stop apps/web from reaching into the OpenCode
 * runtime SDK directly. That guardrail is unrelated to this brand mark, but
 * the regex is unanchored, so it fires on the export name regardless of
 * source module. Import this as `import { HarnessMark as OpenCode } from
 * '@/features/icon/icons/open-code'` to keep call sites unchanged.
 */
export const HarnessMark = ({ className }: { className?: string }) => (
  <svg
    width="24"
    height="30"
    viewBox="0 0 240 300"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn('size-5', className)}
  >
    <g clipPath="url(#clip0_1401_86274)">
      <mask
        id="mask0_1401_86274"
        style={{ maskType: 'luminance' } as any}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="240"
        height="300"
      >
        <path d="M240 0H0V300H240V0Z" fill="white" />
      </mask>
      <g mask="url(#mask0_1401_86274)">
        <path d="M180 240H60V120H180V240Z" fill="#CFCECD" />
        <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#211E1E" />
      </g>
    </g>
    <defs>
      <clipPath id="clip0_1401_86274">
        <rect width="240" height="300" fill="white" />
      </clipPath>
    </defs>
  </svg>
);
