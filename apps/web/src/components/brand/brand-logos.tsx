/**
 * Official brand logos — Apple / Windows / Linux / Google Play.
 *
 * All four marks the /download page needs live here, so its five rows draw from
 * one source rather than mixing a local wrapper with a raw icon import. Apple
 * covers two rows: macOS on the desktop card, iPhone and iPad on the mobile one.
 *
 * NOTHING in this module may be a client component, and that is the whole
 * reason it exists — /download is server-rendered, so its marks must come
 * from a plain server-safe module, not a `'use client'` one. This is the only
 * copy of these four glyphs: `features/icon/icons/apple.tsx`,
 * `google-play-store.tsx`, `windows.tsx`, and `linux.tsx` are each a `'use
 * client'` re-export of the mark below (e.g. `export { AppleMark as Apple }
 * from '@/components/brand/brand-logos'`), so client call sites reading
 * `Icon.Apple` and this server module both resolve to the same source.
 *
 * Same reason the Phosphor marks come from `@/lib/icons/ssr` and not
 * `@phosphor-icons/react`: the main entry calls createContext at module scope
 * and crashes any server component that reaches it. The explicit weight="fill"
 * still wins over the bound default, so those glyphs stay solid regardless of
 * DEFAULT_ICON_WEIGHT.
 *
 * Apple, Windows and Linux are `currentColor` and inherit the row's text
 * colour. Google Play is the four-colour original, because its mark has no
 * recognisable single-colour form — flattening it produces a bare triangle.
 *
 * Every mark is `aria-hidden`. Each one sits beside its own platform name in
 * the row, so announcing the logo as well is duplication, not information.
 */

import { cn } from '@/lib/utils';

type MarkProps = { className?: string };

/**
 * `size-4` is a default, not a fixed size — `cn` runs tailwind-merge, so a
 * caller passing `size-5` replaces it rather than fighting it.
 */
export function AppleMark({ className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 41.5 51"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('size-4', className)}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M40.2,17.4c-3.4,2.1-5.5,5.7-5.5,9.7c0,4.5,2.7,8.6,6.8,10.3c-0.8,2.6-2,5-3.5,7.2
          c-2.2,3.1-4.5,6.3-7.9,6.3s-4.4-2-8.4-2c-3.9,0-5.3,2.1-8.5,2.1s-5.4-2.9-7.9-6.5C2,39.5,0.1,33.7,0,27.6
          c0-9.9,6.4-15.2,12.8-15.2c3.4,0,6.2,2.2,8.3,2.2c2,0,5.2-2.3,9-2.3C34.1,12.2,37.9,14.1,40.2,17.4z
          M28.3,8.1C30,6.1,30.9,3.6,31,1c0-0.3,0-0.7-0.1-1c-2.9,0.3-5.6,1.7-7.5,3.9c-1.7,1.9-2.7,4.3-2.8,6.9c0,0.3,0,0.6,0.1,0.9
          c0.2,0,0.5,0.1,0.7,0.1C24.1,11.6,26.6,10.2,28.3,8.1z"
      />
    </svg>
  );
}

export function PlayStoreMark({ className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 466 511.98"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('size-4', className)}
      aria-hidden="true"
    >
      <path
        fill="#EA4335"
        d="M199.9 237.8l-198.5 232.37c7.22,24.57 30.16,41.81 55.8,41.81 11.16,0 20.93,-2.79 29.3,-8.37l0 0 244.16 -139.46 -130.76 -126.35z"
      />
      <path
        fill="#FBBC04"
        d="M433.91 205.1l0 0 -104.65 -60 -111.61 110.22 113.01 108.83 104.64 -58.6c18.14,-9.77 30.7,-29.3 30.7,-50.23 -1.4,-20.93 -13.95,-40.46 -32.09,-50.22z"
      />
      <path
        fill="#34A853"
        d="M199.42 273.45l129.85 -128.35 -241.37 -136.73c-8.37,-5.58 -19.54,-8.37 -30.7,-8.37 -26.5,0 -50.22,18.14 -55.8,41.86 0,0 0,0 0,0l198.02 231.59z"
      />
      <path
        fill="#4285F4"
        d="M1.39 41.86c-1.39,4.18 -1.39,9.77 -1.39,15.34l0 397.64c0,5.57 0,9.76 1.4,15.34l216.27 -214.86 -216.28 -213.46z"
      />
    </svg>
  );
}

export function WindowsMark({ className }: MarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="32"
      height="32"
      fill="currentColor"
      viewBox="0 0 256 256"
      className={cn('size-4', className)}
      aria-hidden="true"
    >
      <path d="M104,144v51.64a8,8,0,0,1-8,8,8.54,8.54,0,0,1-1.43-.13l-64-11.64A8,8,0,0,1,24,184V144a8,8,0,0,1,8-8H96A8,8,0,0,1,104,144Zm-2.87-89.78a8,8,0,0,0-6.56-1.73l-64,11.64A8,8,0,0,0,24,72v40a8,8,0,0,0,8,8H96a8,8,0,0,0,8-8V60.36A8,8,0,0,0,101.13,54.22ZM208,136H128a8,8,0,0,0-8,8v57.45a8,8,0,0,0,6.57,7.88l80,14.54A7.61,7.61,0,0,0,208,224a8,8,0,0,0,8-8V144A8,8,0,0,0,208,136Zm5.13-102.14a8,8,0,0,0-6.56-1.73l-80,14.55A8,8,0,0,0,120,54.55V112a8,8,0,0,0,8,8h80a8,8,0,0,0,8-8V40A8,8,0,0,0,213.13,33.86Z"></path>
    </svg>
  );
}

export function LinuxMark({ className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('size-4 origin-center scale-[1.5]', className)}
      aria-hidden="true"
    >
      <path
        d="M30 16C30 23.73 23.73 30 16 30C8.27 30 2 23.73 2 16C2 8.27 8.27 2 16 2C23.73 2 30 8.27 30 16Z"
        fill="white"
      />
      <path
        d="M11.31 21.91C11.18 21.72 11.07 21.47 10.98 21.17C9.38 19.36 10.62 16.69 11.84 14.88C11.96 14.69 12.09 14.5 12.23 14.32C13.17 13.16 13.41 12.35 13.48 11.25C13.49 11.05 13.47 10.78 13.45 10.47C13.35 8.88 13.19 6.25 16.02 6.02C19.55 5.73 19.26 8.97 19.23 10.87C19.23 10.95 19.23 11.03 19.23 11.1C19.22 12.25 19.82 13.03 20.45 13.85C20.67 14.15 20.91 14.46 21.11 14.78C21.12 14.79 21.12 14.8 21.13 14.81C22.22 16.39 23.3 18.74 21.8 20.97C21.59 21.73 21.27 22.42 20.84 22.99C19.31 25.01 17.95 24.8 16.89 24.64C16.57 24.59 16.28 24.55 16.02 24.57C15.58 24.6 15.23 24.67 14.93 24.73C13.76 24.96 13.3 25.06 11.31 21.91Z"
        fill="#000000"
      />
      <path
        d="M18.01 7.79C17.98 8.73 16.99 9.54 15.81 9.61C14.62 9.69 13.69 8.98 13.72 8.05C13.76 7.11 14.75 6.3 15.93 6.23C17.12 6.16 18.05 6.86 18.01 7.79Z"
        fill="url(#paint0_linear_87_7435)"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M15.87 10.06C15.88 10.57 16.11 11 16.43 11.2C15.37 11.1 14.05 11.49 14.05 12.23C14.03 13.47 13.34 15.02 12.84 16.13C12.74 16.35 12.65 16.56 12.58 16.74C12.27 17.5 12.08 18.32 12.06 19.12C11.24 17.99 11.84 16.55 12.16 15.92C12.58 15.09 12.58 14.99 12.41 15.19C11.78 16.26 10.58 18.43 12.08 19.74C12.12 20.32 12.27 20.88 12.52 21.4C14.52 25.44 18.28 23.78 19.51 21.69C19.68 21.39 19.81 21.1 19.92 20.82C19.98 20.86 20.05 20.89 20.12 20.91C20.74 21.09 21.67 20.39 21.89 19.96C22.16 19.38 21.89 18.98 20.97 18.51C20.92 18.49 20.88 18.47 20.83 18.45C21.18 16.97 20.21 15.43 19.52 14.77C19.39 14.74 19.37 14.82 19.57 15.02C20.01 15.43 20.96 16.92 20.44 18.31C20.36 18.29 20.28 18.27 20.2 18.26C20.04 17.32 19.62 16.58 19.33 16.07C19.26 15.95 19.2 15.84 19.15 15.75C19.05 15.56 18.94 15.37 18.81 15.16C18.33 14.36 17.74 13.38 17.74 11.94C17.67 11.62 17.37 11.41 16.97 11.29C17.43 11.2 17.78 10.66 17.77 10.01C17.75 9.31 17.31 8.75 16.79 8.76C16.27 8.77 15.85 9.36 15.87 10.06ZM16.3 10.22C16.29 10.61 16.47 10.92 16.72 10.92C16.95 10.92 17.16 10.61 17.16 10.22C17.17 9.84 16.99 9.52 16.74 9.52C16.5 9.52 16.3 9.84 16.3 10.22Z"
        fill="url(#paint1_linear_87_7435)"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14.56 11.15C14.94 11.13 15.21 10.62 15.18 10.01C15.15 9.41 14.81 8.94 14.43 8.96C14.05 8.98 13.78 9.49 13.81 10.09C13.84 10.7 14.18 11.17 14.56 11.15ZM14.78 10.22C14.82 10.54 14.7 10.82 14.53 10.84C14.36 10.86 14.2 10.63 14.16 10.31C14.13 9.99 14.25 9.71 14.42 9.69C14.59 9.67 14.75 9.9 14.78 10.22Z"
        fill="url(#paint2_linear_87_7435)"
      />
      <path
        d="M16.4 10C16.38 10.22 16.47 10.39 16.61 10.41C16.75 10.42 16.88 10.25 16.9 10.04C16.92 9.82 16.82 9.65 16.68 9.63C16.55 9.62 16.42 9.79 16.4 10Z"
        fill="url(#paint3_linear_87_7435)"
      />
      <path
        d="M14.64 10.05C14.66 10.23 14.59 10.39 14.48 10.4C14.38 10.41 14.28 10.28 14.26 10.1C14.24 9.92 14.31 9.76 14.42 9.75C14.52 9.73 14.62 9.88 14.64 10.05Z"
        fill="url(#paint4_linear_87_7435)"
      />
      <path
        d="M18.67 17.15C18.67 18.35 17.56 19.9 15.66 19.89C13.7 19.9 12.87 18.35 12.87 17.15C12.87 15.95 14.17 14.98 15.77 14.98C17.37 14.99 18.67 15.95 18.67 17.15Z"
        fill="url(#paint5_linear_87_7435)"
      />
      <path
        d="M17.63 13.39C17.61 14.63 16.84 14.92 15.85 14.92C14.87 14.92 14.16 14.74 14.07 13.39C14.07 12.55 14.87 12.06 15.85 12.06C16.84 12.05 17.63 12.54 17.63 13.39Z"
        fill="url(#paint6_linear_87_7435)"
      />
      <path
        d="M11.69 15.29C12.34 14.28 13.69 12.72 11.95 15.51C10.53 17.81 11.43 19.29 11.88 19.7C13.21 20.92 13.15 21.75 12.11 21.1C9.88 19.72 10.34 17.39 11.69 15.29Z"
        fill="url(#paint7_linear_87_7435)"
      />
      <path
        d="M20.99 15.71C20.43 14.52 18.66 11.5 21.07 15.01C23.27 18.19 21.73 20.4 21.45 20.62C21.18 20.83 20.25 21.28 20.52 20.51C20.8 19.74 22.16 18.28 20.99 15.71Z"
        fill="url(#paint8_linear_87_7435)"
      />
      <path
        d="M11.21 25.1C9.74 24.29 7.61 25.26 8.39 23.07C8.54 22.57 8.16 21.82 8.41 21.34C8.7 20.75 9.34 20.88 9.72 20.48C10.09 20.07 10.32 19.36 11.03 19.47C11.72 19.58 12.18 20.47 12.67 21.56C13.03 22.33 14.3 23.43 14.22 24.3C14.11 25.63 12.65 25.88 11.21 25.1Z"
        fill="url(#paint9_linear_87_7435)"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.88 20.64C9.52 21.03 8.86 20.94 8.6 21.45C8.43 21.78 8.62 22.28 8.64 22.64C8.67 23.08 8.31 23.71 8.49 24.09C8.7 24.52 9.65 24.46 10.07 24.52C11.1 24.67 12.81 26.01 13.74 24.94C14.65 23.9 12.9 22.58 12.47 21.66C12.19 21.03 11.77 19.82 10.99 19.7C10.44 19.62 10.19 20.29 9.88 20.64ZM11.06 19.24C12.03 19.4 12.51 20.65 12.87 21.46C13.41 22.62 15.27 23.88 14.07 25.25C12.97 26.5 11.24 25.16 10.01 24.98C9.39 24.89 8.42 24.95 8.1 24.3C7.82 23.74 8.24 23.23 8.2 22.67C8.16 22.2 7.98 21.68 8.21 21.23C8.53 20.59 9.14 20.75 9.56 20.32C10 19.83 10.26 19.12 11.06 19.24Z"
        fill="#E68C3F"
      />
      <path
        d="M21.38 24.73C22.46 23.37 24.85 23.65 23.24 21.79C22.89 21.39 23 20.54 22.58 20.17C22.09 19.72 21.55 20.09 21.05 19.85C20.55 19.6 20.03 19.12 19.42 19.46C18.81 19.81 18.74 20.71 18.68 21.89C18.63 22.74 17.88 24.16 18.28 24.95C18.86 26.16 20.36 25.99 21.38 24.73Z"
        fill="url(#paint10_linear_87_7435)"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M21.81 19.7C22.09 19.69 22.41 19.71 22.72 19.99C23.11 20.33 23.11 20.89 23.26 21.35C23.43 21.9 24.03 22.21 24 22.86C23.94 23.91 22.11 24.17 21.55 24.88C21.01 25.54 20.33 25.94 19.68 26C18.7 26.08 17.89 25.25 17.95 24.24C17.99 23.43 18.41 22.69 18.46 21.88C18.49 21.29 18.52 20.75 18.63 20.3C18.73 19.86 18.93 19.47 19.31 19.26C20.15 18.79 20.95 19.72 21.81 19.7ZM19.52 19.66C19.3 19.79 19.15 20.03 19.06 20.42C18.96 20.81 18.93 21.31 18.9 21.9C18.85 22.72 18.44 23.46 18.39 24.27C18.35 25 18.91 25.6 19.65 25.53C20.15 25.49 20.73 25.18 21.21 24.58C21.64 24.04 23.51 23.53 23.55 22.83C23.58 22.38 22.98 21.95 22.84 21.49C22.72 21.14 22.72 20.59 22.44 20.34C22.25 20.18 22.06 20.15 21.82 20.16C21.12 20.18 20.18 19.3 19.52 19.66Z"
        fill="#E68C3F"
      />
      <path
        d="M20.92 22.92C22.58 20.37 21.34 20.39 20.92 20.19C20.5 19.98 20.06 19.58 19.57 19.86C19.08 20.15 19.06 20.88 19.04 21.85C19.02 22.54 18.47 23.71 18.8 24.35C19.21 25.11 20.19 24.01 20.92 22.92Z"
        fill="url(#paint11_linear_87_7435)"
      />
      <path
        d="M10.87 23.28C8.38 21.61 9.55 21.04 9.92 20.77C10.37 20.43 10.38 19.78 10.93 19.84C11.49 19.9 11.82 20.62 12.19 21.5C12.47 22.13 13.42 22.98 13.35 23.71C13.26 24.56 11.94 24 10.87 23.28Z"
        fill="url(#paint12_linear_87_7435)"
      />
      <path
        d="M21.75 19.94C21.55 20.29 20.75 20.85 20.22 20.7C19.68 20.56 19.43 19.76 19.54 19.16C19.64 18.48 20.22 18.45 20.96 18.79C21.73 19.15 21.98 19.47 21.75 19.94Z"
        fill="#000000"
      />
      <path
        d="M21.21 19.74C21.09 19.98 20.56 20.37 20.2 20.27C19.83 20.17 19.65 19.62 19.7 19.2C19.76 18.73 20.15 18.7 20.65 18.94C21.18 19.19 21.35 19.41 21.21 19.74Z"
        fill="url(#paint13_linear_87_7435)"
      />
      <path
        d="M14.44 10.86C14.7 10.61 15.33 9.84 16.54 10.64C16.76 10.79 16.95 10.8 17.37 10.99C18.23 11.36 17.82 12.25 16.91 12.55C16.51 12.67 16.16 13.17 15.45 13.12C14.84 13.09 14.69 12.67 14.31 12.45C13.65 12.06 13.55 11.54 13.91 11.26C14.27 10.98 14.41 10.88 14.44 10.86Z"
        fill="url(#paint14_linear_87_7435)"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M13.99 11.37C13.86 11.48 13.81 11.62 13.86 11.77C13.95 12.09 14.62 12.53 14.88 12.75C15.02 12.87 15.19 12.97 15.46 12.98C16.04 13.02 16.36 12.58 16.87 12.41C17.2 12.3 17.9 11.89 17.67 11.41C17.47 11.01 16.8 10.98 16.47 10.76C15.89 10.37 15.48 10.38 15.18 10.48C14.85 10.6 14.29 11.14 13.99 11.37ZM15.09 10.22C15.48 10.08 15.98 10.1 16.61 10.52C17.03 10.8 17.66 10.77 17.91 11.29C18.23 11.94 17.46 12.51 16.95 12.68C16.4 12.86 16.1 13.31 15.44 13.26C15.11 13.24 14.89 13.12 14.71 12.97C14.34 12.66 13.72 12.36 13.57 11.87C13.49 11.6 13.61 11.32 13.83 11.15C14.19 10.87 14.68 10.37 15.09 10.22Z"
        fill="#E68C3F"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M17.47 11.57C17.48 11.62 17.44 11.66 17.39 11.66C16.7 11.7 16.21 12.5 15.43 12.5C14.99 12.5 14.64 12.28 14.39 12.08C14.34 12.04 13.9 11.7 13.9 11.61C13.9 11.56 13.94 11.52 13.99 11.52C14.08 11.52 14.36 11.82 14.47 11.91C14.7 12.1 15.05 12.31 15.43 12.31C16.2 12.31 16.68 11.52 17.38 11.48C17.43 11.48 17.47 11.52 17.47 11.57Z"
        fill="#E68C3F"
      />
      <path
        d="M14.84 10.79C14.98 10.67 15.39 10.33 15.93 10.67C16.05 10.74 16.17 10.82 16.34 10.92C16.68 11.13 16.51 11.44 16.1 11.63C15.91 11.71 15.59 11.88 15.36 11.87C15.09 11.84 14.92 11.67 14.75 11.55C14.42 11.33 14.44 11.15 14.6 11.01C14.71 10.9 14.83 10.8 14.84 10.79Z"
        fill="url(#paint15_linear_87_7435)"
      />
      <defs>
        <linearGradient
          id="paint0_linear_87_7435"
          x1={16.0578}
          y1={6.30617}
          x2={15.8364}
          y2={9.30598}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity={0.8} />
          <stop offset={1} stopColor="white" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id="paint1_linear_87_7435"
          x1={12.8966}
          y1={22.6721}
          x2={11.2506}
          y2={17.2716}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFEED7" />
          <stop offset={1} stopColor="#BDBFC2" />
        </linearGradient>
        <linearGradient
          id="paint2_linear_87_7435"
          x1={12.8966}
          y1={22.6721}
          x2={11.2506}
          y2={17.2716}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFEED7" />
          <stop offset={1} stopColor="#BDBFC2" />
        </linearGradient>
        <linearGradient
          id="paint3_linear_87_7435"
          x1={16.6681}
          y1={9.65546}
          x2={16.5748}
          y2={10.3542}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity={0.65} />
          <stop offset={1} stopColor="white" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id="paint4_linear_87_7435"
          x1={14.434}
          y1={9.78294}
          x2={14.5344}
          y2={10.3483}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity={0.65} />
          <stop offset={1} stopColor="white" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id="paint5_linear_87_7435"
          x1={15.7613}
          y1={15.6306}
          x2={15.778}
          y2={19.6272}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity={0.8} />
          <stop offset={1} stopColor="white" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id="paint6_linear_87_7435"
          x1={15.8504}
          y1={13.1247}
          x2={15.8688}
          y2={14.7138}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity={0.65} />
          <stop offset={1} stopColor="white" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id="paint7_linear_87_7435"
          x1={11.72}
          y1={14.1055}
          x2={11.72}
          y2={19.9372}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity={0.65} />
          <stop offset={1} stopColor="white" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id="paint8_linear_87_7435"
          x1={21.033}
          y1={13.5359}
          x2={21.0308}
          y2={18.8052}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity={0.65} />
          <stop offset={1} stopColor="white" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id="paint9_linear_87_7435"
          x1={11.4286}
          y1={22.4374}
          x2={10.5354}
          y2={25.4214}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFA63F" />
          <stop offset={1} stopColor="#FFFF00" />
        </linearGradient>
        <linearGradient
          id="paint10_linear_87_7435"
          x1={19.882}
          y1={21.53}
          x2={22.2656}
          y2={24.7801}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFA63F" />
          <stop offset={1} stopColor="#FFFF00" />
        </linearGradient>
        <linearGradient
          id="paint11_linear_87_7435"
          x1={20.5198}
          y1={18.9333}
          x2={19.6863}
          y2={22.8605}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity={0.65} />
          <stop offset={1} stopColor="white" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id="paint12_linear_87_7435"
          x1={11.2464}
          y1={19.9042}
          x2={11.4117}
          y2={24.3239}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity={0.65} />
          <stop offset={1} stopColor="white" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id="paint13_linear_87_7435"
          x1={20.3755}
          y1={18.8616}
          x2={20.5688}
          y2={20.1822}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity={0.65} />
          <stop offset={1} stopColor="white" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id="paint14_linear_87_7435"
          x1={15.7644}
          y1={10.784}
          x2={15.7805}
          y2={13.1098}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFA63F" />
          <stop offset={1} stopColor="#FFFF00" />
        </linearGradient>
        <linearGradient
          id="paint15_linear_87_7435"
          x1={15.5106}
          y1={10.5638}
          x2={15.5062}
          y2={11.7936}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity={0.65} />
          <stop offset={1} stopColor="white" stopOpacity={0} />
        </linearGradient>
      </defs>
    </svg>
  );
}
