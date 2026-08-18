'use client';

import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';

export const MicrosoftTeams = ({ className }: { className?: string }) => {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="4 4 36 38"
      className={cn('size-4', className)}
    >
      <path
        fill="url(#a)"
        d="M22 20h12c3.31 0 6 2.69 6 6v10c0 3.31-2.69 6-6 6s-6-2.69-6-6V26c0-3.31-2.69-6-6-6"
      />
      <path
        fill="url(#b)"
        d="M8 24c0-3.31 2.69-6 6-6h8c3.31 0 6 2.69 6 6v12c0 3.31 2.69 6 6 6l-16-.0001c-5.52 0-10-4.48-10-10z"
      />
      <path
        fill="url(#c)"
        fillOpacity=".7"
        d="M8 24c0-3.31 2.69-6 6-6h8c3.31 0 6 2.69 6 6v12c0 3.31 2.69 6 6 6l-16-.0001c-5.52 0-10-4.48-10-10z"
      />
      <path
        fill="url(#d)"
        fillOpacity=".7"
        d="M8 24c0-3.31 2.69-6 6-6h8c3.31 0 6 2.69 6 6v12c0 3.31 2.69 6 6 6l-16-.0001c-5.52 0-10-4.48-10-10z"
      />
      <path
        fill="url(#e)"
        d="M33 18c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5"
      />
      <path
        fill="url(#f)"
        fillOpacity=".46"
        d="M33 18c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5"
      />
      <path
        fill="url(#g)"
        fillOpacity=".4"
        d="M33 18c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5"
      />
      <path
        fill="url(#h)"
        d="M18 16c3.31 0 6-2.69 6-6 0-3.31-2.69-6-6-6s-6 2.69-6 6c0 3.31 2.69 6 6 6"
      />
      <path
        fill="url(#i)"
        fillOpacity=".6"
        d="M18 16c3.31 0 6-2.69 6-6 0-3.31-2.69-6-6-6s-6 2.69-6 6c0 3.31 2.69 6 6 6"
      />
      <path
        fill="url(#j)"
        fillOpacity=".5"
        d="M18 16c3.31 0 6-2.69 6-6 0-3.31-2.69-6-6-6s-6 2.69-6 6c0 3.31 2.69 6 6 6"
      />
      <rect width="16" height="16" x="4" y="23" fill="url(#k)" rx="3.25" />
      <rect width="16" height="16" x="4" y="23" fill="url(#l)" fillOpacity=".7" rx="3.25" />
      <path
        fill="#fff"
        d="M15.48 28.11h-2.45v7.466h-2.06v-7.466H8.52v-1.68h6.96z"
      />
      <defs>
        <radialGradient
          id="a"
          cx="0"
          cy="0"
          r="1"
          gradientTransform={tI18nHardcoded.raw(
            'autoFeaturesIconIconJsxAttrGradientTransformMatrix134784080dcd1a2',
          )}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#a98aff" />
          <stop offset=".14" stopColor="#8c75ff" />
          <stop offset=".565" stopColor="#5f50e2" />
          <stop offset=".9" stopColor="#3c2cb8" />
        </radialGradient>
        <radialGradient
          id="b"
          cx="0"
          cy="0"
          r="1"
          gradientTransform={tI18nHardcoded.raw(
            'autoFeaturesIconIconJsxAttrGradientTransformRotate681539705bbe58f',
          )}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#85c2ff" />
          <stop offset=".69" stopColor="#7588ff" />
          <stop offset="1" stopColor="#6459fe" />
        </radialGradient>
        <radialGradient
          id="d"
          cx="0"
          cy="0"
          r="1"
          gradientTransform={tI18nHardcoded.raw(
            'autoFeaturesIconIconJsxAttrGradientTransformRotate11332682d9828e3',
          )}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#bd96ff" />
          <stop offset=".686685" stopColor="#bd96ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id="e"
          cx="0"
          cy="0"
          r="1"
          gradientTransform={tI18nHardcoded.raw(
            'autoFeaturesIconIconJsxAttrGradientTransformMatrix01012f866ac38',
          )}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".268201" stopColor="#6868f7" />
          <stop offset="1" stopColor="#3923b1" />
        </radialGradient>
        <radialGradient
          id="f"
          cx="0"
          cy="0"
          r="1"
          gradientTransform={tI18nHardcoded.raw(
            'autoFeaturesIconIconJsxAttrGradientTransformRotate40051603068196b1fe2992',
          )}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".270711" stopColor="#a1d3ff" />
          <stop offset=".813393" stopColor="#a1d3ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id="g"
          cx="0"
          cy="0"
          r="1"
          gradientTransform={tI18nHardcoded.raw(
            'autoFeaturesIconIconJsxAttrGradientTransformRotate416581323f58d687',
          )}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#e3acfd" />
          <stop offset=".816041" stopColor="#9fa2ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id="h"
          cx="0"
          cy="0"
          r="1"
          gradientTransform={tI18nHardcoded.raw(
            'autoFeaturesIconIconJsxAttrGradientTransformMatrix01215c59ab36f',
          )}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".268201" stopColor="#8282ff" />
          <stop offset="1" stopColor="#3923b1" />
        </radialGradient>
        <radialGradient
          id="i"
          cx="0"
          cy="0"
          r="1"
          gradientTransform={tI18nHardcoded.raw(
            'autoFeaturesIconIconJsxAttrGradientTransformRotate4005163c117110d',
          )}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".270711" stopColor="#a1d3ff" />
          <stop offset=".813393" stopColor="#a1d3ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id="j"
          cx="0"
          cy="0"
          r="1"
          gradientTransform={tI18nHardcoded.raw(
            'autoFeaturesIconIconJsxAttrGradientTransformRotate4165812089e5adbd',
          )}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#e3acfd" />
          <stop offset=".816041" stopColor="#9fa2ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id="k"
          cx="0"
          cy="0"
          r="1"
          gradientTransform={tI18nHardcoded.raw(
            'autoFeaturesIconIconJsxAttrGradientTransformRotate452576345597a649bf7b',
          )}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".046875" stopColor="#688eff" />
          <stop offset=".946875" stopColor="#230f94" />
        </radialGradient>
        <radialGradient
          id="l"
          cx="0"
          cy="0"
          r="1"
          gradientTransform={tI18nHardcoded.raw(
            'autoFeaturesIconIconJsxAttrGradientTransformMatrix01122d674bc1',
          )}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".570647" stopColor="#6965f6" stopOpacity="0" />
          <stop offset="1" stopColor="#8f8fff" />
        </radialGradient>
        <linearGradient
          id="c"
          x1="20.5936"
          x2="20.5936"
          y1="18"
          y2="42"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".801159" stopColor="#6864f6" stopOpacity="0" />
          <stop offset="1" stopColor="#5149de" />
        </linearGradient>
      </defs>
    </svg>
  );
};
