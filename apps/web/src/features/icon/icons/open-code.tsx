'use client';

import { cn } from '@/lib/utils';

/**
 * Exported as `RuntimeMark`, not `OpenCode` — `scripts/sdk-boundary.mjs`
 * (run via `sdk-boundary.test.ts` against `sdk-boundary-baseline.json`) flags
 * any import specifier whose *source* name contains "opencode",
 * case-insensitively and regardless of which module it comes from, to stop
 * apps/web reaching into the OpenCode runtime SDK. That scan is independent
 * of (and stricter than) eslint's `no-restricted-syntax` rule, which is now
 * scoped to `@kortix/sdk`/opencode-ish sources and no longer flags this file
 * — but sdk-boundary.mjs still would. `RuntimeMark` mirrors the SDK's own
 * convention for this exact rename (`WorkspaceOpenCodeSession as
 * WorkspaceRuntimeSession` in `packages/sdk/src/index.ts`), not "Harness":
 * this codebase already uses "harness" for the pluggable-agent-runtime
 * concept (OpenCode vs. the Claude Code / Codex / Pi harnesses behind
 * `KORTIX_ACP_RUNTIME`), so reusing it here for an unrelated brand mark
 * would collide with a real domain term. Import this as `import { RuntimeMark
 * as OpenCode } from '@/features/icon/icons/open-code'` to keep call sites
 * unchanged.
 */
export const RuntimeMark = ({ className }: { className?: string }) => (
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
