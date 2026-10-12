'use client';

import { useId } from 'react';

import { cn } from '@/lib/utils';

/** Edge brand mark, full colour. Source: gilbarbara/logos (CC0), `logos:microsoft-edge`. */
export const Edge = ({ className }: { className?: string }) => {
  // Gradient ids are per instance, so two marks on one page never share a definition.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <svg
      viewBox="0 0 256 256"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn('size-4', className)}
    >
      <defs>
        <radialGradient
          id={`${uid}SVGHFrboeCQ`}
          cx="161.83"
          cy="788.401"
          r="95.38"
          gradientTransform="matrix(.9999 0 0 .9498 -4.622 -570.387)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".72" stopOpacity="0" />
          <stop offset=".95" stopOpacity=".53" />
          <stop offset="1" />
        </radialGradient>
        <radialGradient
          id={`${uid}SVGVG94vbPK`}
          cx="-773.636"
          cy="746.715"
          r="143.24"
          gradientTransform="matrix(.15 -.9898 .8 .12 -410.718 -656.341)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".76" stopOpacity="0" />
          <stop offset=".95" stopOpacity=".5" />
          <stop offset="1" />
        </radialGradient>
        <radialGradient
          id={`${uid}SVGw2d8JdCl`}
          cx="230.593"
          cy="-106.038"
          r="202.43"
          gradientTransform="matrix(-.04 .9998 -2.1299 -.07998 -190.775 -191.635)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#35c1f1" />
          <stop offset=".11" stopColor="#34c1ed" />
          <stop offset=".23" stopColor="#2fc2df" />
          <stop offset=".31" stopColor="#2bc3d2" />
          <stop offset=".67" stopColor="#36c752" />
        </radialGradient>
        <radialGradient
          id={`${uid}SVGIqWItcPR`}
          cx="536.357"
          cy="-117.703"
          r="97.34"
          gradientTransform="matrix(.28 .9598 -.78 .23 -1.928 -410.318)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#66eb6e" />
          <stop offset="1" stopColor="#66eb6e" stopOpacity="0" />
        </radialGradient>
        <linearGradient
          id={`${uid}SVGktZSUcGK`}
          x1="63.334"
          x2="241.617"
          y1="757.83"
          y2="757.83"
          gradientTransform="translate(-4.63 -580.81)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#0c59a4" />
          <stop offset="1" stopColor="#114a8b" />
        </linearGradient>
        <linearGradient
          id={`${uid}SVGaPqZBebW`}
          x1="157.401"
          x2="46.028"
          y1="680.556"
          y2="801.868"
          gradientTransform="translate(-4.63 -580.81)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#1b9de2" />
          <stop offset=".16" stopColor="#1595df" />
          <stop offset=".67" stopColor="#0680d7" />
          <stop offset="1" stopColor="#0078d4" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${uid}SVGktZSUcGK)`}
        d="M231 190.5c-3.4 1.8-6.9 3.4-10.5 4.7c-11.5 4.3-23.6 6.5-35.9 6.5c-47.3 0-88.5-32.5-88.5-74.3c.1-11.4 6.4-21.9 16.4-27.3c-42.8 1.8-53.8 46.4-53.8 72.5c0 73.9 68.1 81.4 82.8 81.4c7.9 0 19.8-2.3 27-4.6l1.3-.4c27.6-9.5 51-28.1 66.6-52.8c1.2-1.9.6-4.3-1.2-5.5c-1.3-.8-2.9-.9-4.2-.2"
      />
      <path
        fill={`url(#${uid}SVGHFrboeCQ)`}
        d="M231 190.5c-3.4 1.8-6.9 3.4-10.5 4.7c-11.5 4.3-23.6 6.5-35.9 6.5c-47.3 0-88.5-32.5-88.5-74.3c.1-11.4 6.4-21.9 16.4-27.3c-42.8 1.8-53.8 46.4-53.8 72.5c0 73.9 68.1 81.4 82.8 81.4c7.9 0 19.8-2.3 27-4.6l1.3-.4c27.6-9.5 51-28.1 66.6-52.8c1.2-1.9.6-4.3-1.2-5.5c-1.3-.8-2.9-.9-4.2-.2"
        opacity=".35"
      />
      <path
        fill={`url(#${uid}SVGaPqZBebW)`}
        d="M105.7 241.4c-8.9-5.5-16.6-12.8-22.7-21.3c-26.3-36-18.4-86.5 17.6-112.8c3.8-2.7 7.7-5.2 11.9-7.2c3.1-1.5 8.4-4.1 15.5-4c10.1.1 19.6 4.9 25.7 13c4 5.4 6.3 11.9 6.4 18.7c0-.2 24.5-79.6-80-79.6c-43.9 0-80 41.7-80 78.2c-.2 19.3 4 38.5 12.1 56c27.6 58.8 94.8 87.6 156.4 67.1c-21.1 6.6-44.1 3.7-62.9-8.1"
      />
      <path
        fill={`url(#${uid}SVGVG94vbPK)`}
        d="M105.7 241.4c-8.9-5.5-16.6-12.8-22.7-21.3c-26.3-36-18.4-86.5 17.6-112.8c3.8-2.7 7.7-5.2 11.9-7.2c3.1-1.5 8.4-4.1 15.5-4c10.1.1 19.6 4.9 25.7 13c4 5.4 6.3 11.9 6.4 18.7c0-.2 24.5-79.6-80-79.6c-43.9 0-80 41.7-80 78.2c-.2 19.3 4 38.5 12.1 56c27.6 58.8 94.8 87.6 156.4 67.1c-21.1 6.6-44.1 3.7-62.9-8.1"
        opacity=".41"
      />
      <path
        fill={`url(#${uid}SVGw2d8JdCl)`}
        d="M152.3 148.9c-.8 1-3.3 2.5-3.3 5.7c0 2.6 1.7 5.1 4.7 7.2c14.4 10 41.5 8.7 41.6 8.7c10.7 0 21.1-2.9 30.3-8.3c18.8-11 30.4-31.1 30.4-52.9c.3-22.4-8-37.3-11.3-43.9C223.5 23.9 177.7 0 128 0C58 0 1 56.2 0 126.2c.5-36.5 36.8-66 80-66c3.5 0 23.5.3 42 10.1c16.3 8.6 24.9 18.9 30.8 29.2c6.2 10.7 7.3 24.1 7.3 29.5c0 5.3-2.7 13.3-7.8 19.9"
      />
      <path
        fill={`url(#${uid}SVGIqWItcPR)`}
        d="M152.3 148.9c-.8 1-3.3 2.5-3.3 5.7c0 2.6 1.7 5.1 4.7 7.2c14.4 10 41.5 8.7 41.6 8.7c10.7 0 21.1-2.9 30.3-8.3c18.8-11 30.4-31.1 30.4-52.9c.3-22.4-8-37.3-11.3-43.9C223.5 23.9 177.7 0 128 0C58 0 1 56.2 0 126.2c.5-36.5 36.8-66 80-66c3.5 0 23.5.3 42 10.1c16.3 8.6 24.9 18.9 30.8 29.2c6.2 10.7 7.3 24.1 7.3 29.5c0 5.3-2.7 13.3-7.8 19.9"
      />
    </svg>
  );
};
