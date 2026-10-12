'use client';

import { useId } from 'react';

import { cn } from '@/lib/utils';

/** Firefox brand mark, full colour. Source: gilbarbara/logos (CC0), `logos:firefox`. */
export const Firefox = ({ className }: { className?: string }) => {
  // Gradient ids are per instance, so two marks on one page never share a definition.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <svg
      viewBox="0 0 256 265"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn('size-4', className)}
    >
      <defs>
        <radialGradient
          id={`${uid}SVGyidrs6Xz`}
          cx="-7907.187"
          cy="-8515.121"
          r="80.797"
          gradientTransform="translate(26367.938 28186.305)scale(3.3067)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".129" stopColor="#ffbd4f" />
          <stop offset=".186" stopColor="#ffac31" />
          <stop offset=".247" stopColor="#ff9d17" />
          <stop offset=".283" stopColor="#ff980e" />
          <stop offset=".403" stopColor="#ff563b" />
          <stop offset=".467" stopColor="#ff3750" />
          <stop offset=".71" stopColor="#f5156c" />
          <stop offset=".782" stopColor="#eb0878" />
          <stop offset=".86" stopColor="#e50080" />
        </radialGradient>
        <radialGradient
          id={`${uid}SVG0IVpgbgM`}
          cx="-7936.711"
          cy="-8482.089"
          r="80.797"
          gradientTransform="translate(26367.938 28186.305)scale(3.3067)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".3" stopColor="#960e18" />
          <stop offset=".351" stopColor="#b11927" stopOpacity=".74" />
          <stop offset=".435" stopColor="#db293d" stopOpacity=".343" />
          <stop offset=".497" stopColor="#f5334b" stopOpacity=".094" />
          <stop offset=".53" stopColor="#ff3750" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={`${uid}SVG5bHMjbfc`}
          cx="-7926.97"
          cy="-8533.457"
          r="58.534"
          gradientTransform="translate(26367.938 28186.305)scale(3.3067)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".132" stopColor="#fff44f" />
          <stop offset=".252" stopColor="#ffdc3e" />
          <stop offset=".506" stopColor="#ff9d12" />
          <stop offset=".526" stopColor="#ff980e" />
        </radialGradient>
        <radialGradient
          id={`${uid}SVGEHoaNdMW`}
          cx="-7945.648"
          cy="-8460.984"
          r="38.471"
          gradientTransform="translate(26367.938 28186.305)scale(3.3067)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".353" stopColor="#3a8ee6" />
          <stop offset=".472" stopColor="#5c79f0" />
          <stop offset=".669" stopColor="#9059ff" />
          <stop offset="1" stopColor="#c139e6" />
        </radialGradient>
        <radialGradient
          id={`${uid}SVG6OUB2b6N`}
          cx="-7935.62"
          cy="-8491.546"
          r="20.397"
          gradientTransform="matrix(3.21411 -.77707 .90934 3.76302 33365.914 25904.014)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".206" stopColor="#9059ff" stopOpacity="0" />
          <stop offset=".278" stopColor="#8c4ff3" stopOpacity=".064" />
          <stop offset=".747" stopColor="#7716a8" stopOpacity=".45" />
          <stop offset=".975" stopColor="#6e008b" stopOpacity=".6" />
        </radialGradient>
        <radialGradient
          id={`${uid}SVGfyXvUXoB`}
          cx="-7937.731"
          cy="-8518.427"
          r="27.676"
          gradientTransform="translate(26367.938 28186.305)scale(3.3067)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffe226" />
          <stop offset=".121" stopColor="#ffdb27" />
          <stop offset=".295" stopColor="#ffc82a" />
          <stop offset=".502" stopColor="#ffa930" />
          <stop offset=".732" stopColor="#ff7e37" />
          <stop offset=".792" stopColor="#ff7139" />
        </radialGradient>
        <radialGradient
          id={`${uid}SVGT2ddtPSF`}
          cx="-7915.977"
          cy="-8535.981"
          r="118.081"
          gradientTransform="translate(26367.938 28186.305)scale(3.3067)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".113" stopColor="#fff44f" />
          <stop offset=".456" stopColor="#ff980e" />
          <stop offset=".622" stopColor="#ff5634" />
          <stop offset=".716" stopColor="#ff3647" />
          <stop offset=".904" stopColor="#e31587" />
        </radialGradient>
        <radialGradient
          id={`${uid}SVGH7WrGcHb`}
          cx="-7927.165"
          cy="-8522.859"
          r="86.499"
          gradientTransform="matrix(.3472 3.29017 -2.15928 .22816 -15491.597 28008.376)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#fff44f" />
          <stop offset=".06" stopColor="#ffe847" />
          <stop offset=".168" stopColor="#ffc830" />
          <stop offset=".304" stopColor="#ff980e" />
          <stop offset=".356" stopColor="#ff8b16" />
          <stop offset=".455" stopColor="#ff672a" />
          <stop offset=".57" stopColor="#ff3647" />
          <stop offset=".737" stopColor="#e31587" />
        </radialGradient>
        <radialGradient
          id={`${uid}SVGLGsqnb9u`}
          cx="-7938.383"
          cy="-8508.176"
          r="73.72"
          gradientTransform="translate(26367.938 28186.305)scale(3.3067)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".137" stopColor="#fff44f" />
          <stop offset=".48" stopColor="#ff980e" />
          <stop offset=".592" stopColor="#ff5634" />
          <stop offset=".655" stopColor="#ff3647" />
          <stop offset=".904" stopColor="#e31587" />
        </radialGradient>
        <radialGradient
          id={`${uid}SVGYSHzlc1q`}
          cx="-7918.923"
          cy="-8503.861"
          r="80.686"
          gradientTransform="translate(26367.938 28186.305)scale(3.3067)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".094" stopColor="#fff44f" />
          <stop offset=".231" stopColor="#ffe141" />
          <stop offset=".509" stopColor="#ffaf1e" />
          <stop offset=".626" stopColor="#ff980e" />
        </radialGradient>
        <linearGradient
          id={`${uid}SVGyUi6ncnI`}
          x1="70.786"
          x2="6.447"
          y1="12.393"
          y2="74.468"
          gradientTransform="translate(-2.999 -.01)scale(3.3067)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".048" stopColor="#fff44f" />
          <stop offset=".111" stopColor="#ffe847" />
          <stop offset=".225" stopColor="#ffc830" />
          <stop offset=".368" stopColor="#ff980e" />
          <stop offset=".401" stopColor="#ff8b16" />
          <stop offset=".462" stopColor="#ff672a" />
          <stop offset=".534" stopColor="#ff3647" />
          <stop offset=".705" stopColor="#e31587" />
        </linearGradient>
        <linearGradient
          id={`${uid}SVG1UrWScUt`}
          x1="70.013"
          x2="15.267"
          y1="12.061"
          y2="66.806"
          gradientTransform="translate(-2.999 -.01)scale(3.3067)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".167" stopColor="#fff44f" stopOpacity=".8" />
          <stop offset=".266" stopColor="#fff44f" stopOpacity=".634" />
          <stop offset=".489" stopColor="#fff44f" stopOpacity=".217" />
          <stop offset=".6" stopColor="#fff44f" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${uid}SVGyUi6ncnI)`}
        d="M248.033 88.713c-5.569-13.399-16.864-27.866-25.71-32.439a133.2 133.2 0 0 1 12.979 38.9l.023.215c-14.49-36.126-39.062-50.692-59.13-82.41a155 155 0 0 1-3.019-4.907a41 41 0 0 1-1.412-2.645a23.3 23.3 0 0 1-1.912-5.076a.33.33 0 0 0-.291-.331a.5.5 0 0 0-.241 0c-.016 0-.043.03-.063.037s-.063.036-.092.049l.049-.086c-32.19 18.849-43.113 53.741-44.118 71.194a64.1 64.1 0 0 0-35.269 13.593a38 38 0 0 0-3.307-2.506a59.4 59.4 0 0 1-.36-31.324a94.9 94.9 0 0 0-30.848 23.841h-.06c-5.079-6.438-4.722-27.667-4.431-32.102a23 23 0 0 0-4.279 2.272a93.4 93.4 0 0 0-12.526 10.73a112 112 0 0 0-11.98 14.375v.019v-.023A108.3 108.3 0 0 0 4.841 108.92l-.171.846a204 204 0 0 0-1.26 8.003c0 .096-.02.185-.03.281a122 122 0 0 0-2.08 17.667v.662c.086 98.661 106.944 160.23 192.344 110.825a128.17 128.17 0 0 0 62.12-89.153c.215-1.653.39-3.29.582-4.96a131.8 131.8 0 0 0-8.313-64.378M100.322 189.031c.599.288 1.161.599 1.776.873l.089.057a69 69 0 0 1-1.865-.93m135.013-93.612v-.123l.023.136z"
      />
      <path
        fill={`url(#${uid}SVGyidrs6Xz)`}
        d="M248.033 88.713c-5.569-13.399-16.864-27.866-25.71-32.439a133.2 133.2 0 0 1 12.979 38.9v.122l.023.136a116.07 116.07 0 0 1-3.988 86.497c-14.688 31.516-50.242 63.819-105.894 62.248c-60.132-1.703-113.089-46.323-122.989-104.766c-1.802-9.216 0-13.888.906-21.378a95.4 95.4 0 0 0-2.06 17.684v.662c.086 98.661 106.944 160.23 192.344 110.825a128.17 128.17 0 0 0 62.12-89.153c.215-1.653.39-3.29.582-4.96a131.8 131.8 0 0 0-8.313-64.378"
      />
      <path
        fill={`url(#${uid}SVG0IVpgbgM)`}
        d="M248.033 88.713c-5.569-13.399-16.864-27.866-25.71-32.439a133.2 133.2 0 0 1 12.979 38.9v.122l.023.136a116.07 116.07 0 0 1-3.988 86.497c-14.688 31.516-50.242 63.819-105.894 62.248c-60.132-1.703-113.089-46.323-122.989-104.766c-1.802-9.216 0-13.888.906-21.378a95.4 95.4 0 0 0-2.06 17.684v.662c.086 98.661 106.944 160.23 192.344 110.825a128.17 128.17 0 0 0 62.12-89.153c.215-1.653.39-3.29.582-4.96a131.8 131.8 0 0 0-8.313-64.378"
      />
      <path
        fill={`url(#${uid}SVG5bHMjbfc)`}
        d="M185.754 103.778c.278.195.536.39.797.585a69.8 69.8 0 0 0-11.904-15.525C134.815 48.999 164.208 2.457 169.165.093l.049-.073c-32.19 18.849-43.113 53.741-44.118 71.194c1.495-.103 2.976-.229 4.504-.229a64.68 64.68 0 0 1 56.154 32.793"
      />
      <path
        fill={`url(#${uid}SVGEHoaNdMW)`}
        d="M129.683 111.734c-.212 3.188-11.475 14.182-15.413 14.182c-36.443 0-42.359 22.046-42.359 22.046c1.614 18.564 14.55 33.854 30.187 41.942c.714.371 1.439.705 2.163 1.032a71 71 0 0 0 3.763 1.541a57 57 0 0 0 16.675 3.217c63.876 2.996 76.25-76.384 30.154-99.419a44.24 44.24 0 0 1 30.901 7.503A64.68 64.68 0 0 0 129.6 70.985c-1.521 0-3.009.126-4.504.229a64.1 64.1 0 0 0-35.269 13.593c1.954 1.654 4.16 3.863 8.806 8.442c8.696 8.568 31 17.443 31.05 18.485"
      />
      <path
        fill={`url(#${uid}SVG6OUB2b6N)`}
        d="M129.683 111.734c-.212 3.188-11.475 14.182-15.413 14.182c-36.443 0-42.359 22.046-42.359 22.046c1.614 18.564 14.55 33.854 30.187 41.942c.714.371 1.439.705 2.163 1.032a71 71 0 0 0 3.763 1.541a57 57 0 0 0 16.675 3.217c63.876 2.996 76.25-76.384 30.154-99.419a44.24 44.24 0 0 1 30.901 7.503A64.68 64.68 0 0 0 129.6 70.985c-1.521 0-3.009.126-4.504.229a64.1 64.1 0 0 0-35.269 13.593c1.954 1.654 4.16 3.863 8.806 8.442c8.696 8.568 31 17.443 31.05 18.485"
      />
      <path
        fill={`url(#${uid}SVGfyXvUXoB)`}
        d="M83.852 80.545a82 82 0 0 1 2.645 1.756a59.4 59.4 0 0 1-.36-31.324a94.9 94.9 0 0 0-30.849 23.841c.625-.017 19.216-.351 28.564 5.727"
      />
      <path
        fill={`url(#${uid}SVGT2ddtPSF)`}
        d="M2.471 139.411c9.89 58.443 62.857 103.063 122.989 104.766c55.652 1.574 91.205-30.732 105.894-62.248a116.07 116.07 0 0 0 3.988-86.497v-.122c0-.096-.02-.153 0-.123l.023.215c4.547 29.684-10.552 58.443-34.155 77.889l-.073.166c-45.989 37.455-90.002 22.598-98.91 16.533a65 65 0 0 1-1.865-.929c-26.814-12.817-37.891-37.247-35.517-58.198a32.91 32.91 0 0 1-30.359-19.096a48.34 48.34 0 0 1 47.117-1.891a63.82 63.82 0 0 0 48.119 1.891c-.049-1.042-22.353-9.92-31.05-18.484c-4.646-4.58-6.851-6.786-8.805-8.442a38 38 0 0 0-3.307-2.507c-.761-.519-1.617-1.081-2.645-1.756c-9.348-6.078-27.939-5.744-28.554-5.727h-.059c-5.079-6.438-4.722-27.667-4.431-32.101a23 23 0 0 0-4.279 2.271a93.4 93.4 0 0 0-12.526 10.73a112 112 0 0 0-12.03 14.342v.019v-.023A108.3 108.3 0 0 0 4.841 108.92c-.062.261-4.616 20.167-2.37 30.491"
      />
      <path
        fill={`url(#${uid}SVGH7WrGcHb)`}
        d="M174.654 88.838a69.8 69.8 0 0 1 11.904 15.542a27 27 0 0 1 1.921 1.574c29.056 26.784 13.832 64.646 12.698 67.341c23.603-19.447 38.688-48.205 34.155-77.89c-14.497-36.142-39.069-50.708-59.137-82.426a155 155 0 0 1-3.019-4.907a41 41 0 0 1-1.412-2.645a23.3 23.3 0 0 1-1.912-5.076a.33.33 0 0 0-.291-.331a.5.5 0 0 0-.241 0c-.016 0-.043.03-.063.037s-.063.036-.092.049c-4.957 2.351-34.35 48.893 5.489 88.732"
      />
      <path
        fill={`url(#${uid}SVGLGsqnb9u)`}
        d="M188.459 105.937a27 27 0 0 0-1.921-1.574c-.261-.195-.519-.39-.797-.585a44.24 44.24 0 0 0-30.901-7.503c46.095 23.048 33.728 102.415-30.154 99.419a57 57 0 0 1-16.675-3.217a67 67 0 0 1-3.763-1.541c-.725-.331-1.449-.661-2.163-1.032l.089.057c8.908 6.081 52.907 20.938 98.91-16.534l.073-.165c1.147-2.679 16.371-40.55-12.698-67.325"
      />
      <path
        fill={`url(#${uid}SVGYSHzlc1q)`}
        d="M71.911 147.962s5.916-22.046 42.359-22.046c3.938 0 15.211-10.994 15.413-14.182a63.82 63.82 0 0 1-48.119-1.892a48.34 48.34 0 0 0-47.118 1.892a32.91 32.91 0 0 0 30.359 19.096c-2.374 20.955 8.703 45.385 35.517 58.198c.599.288 1.161.599 1.776.873c-15.65-8.085-28.573-23.375-30.187-41.939"
      />
      <path
        fill={`url(#${uid}SVG1UrWScUt)`}
        d="M248.033 88.713c-5.569-13.399-16.864-27.866-25.71-32.439a133.2 133.2 0 0 1 12.979 38.9l.023.215c-14.49-36.126-39.062-50.692-59.13-82.41a155 155 0 0 1-3.019-4.907a41 41 0 0 1-1.412-2.645a23.3 23.3 0 0 1-1.912-5.076a.33.33 0 0 0-.291-.331a.5.5 0 0 0-.241 0c-.016 0-.043.03-.063.037s-.063.036-.092.049l.049-.086c-32.19 18.849-43.113 53.741-44.118 71.194c1.495-.103 2.976-.229 4.504-.229a64.68 64.68 0 0 1 56.154 32.793a44.24 44.24 0 0 0-30.901-7.503c46.096 23.048 33.729 102.415-30.154 99.419a57 57 0 0 1-16.675-3.217a67 67 0 0 1-3.763-1.541c-.724-.331-1.449-.661-2.163-1.032l.089.057a69 69 0 0 1-1.865-.93c.599.288 1.161.599 1.776.873c-15.65-8.088-28.573-23.378-30.187-41.942c0 0 5.916-22.046 42.359-22.046c3.938 0 15.211-10.994 15.413-14.182c-.05-1.042-22.354-9.92-31.05-18.485c-4.646-4.579-6.852-6.785-8.806-8.442a38 38 0 0 0-3.307-2.506a59.4 59.4 0 0 1-.36-31.324a94.9 94.9 0 0 0-30.848 23.841h-.06c-5.079-6.438-4.722-27.667-4.431-32.102a23 23 0 0 0-4.279 2.272a93.4 93.4 0 0 0-12.526 10.73a112 112 0 0 0-11.98 14.375v.019v-.023A108.3 108.3 0 0 0 4.841 108.92l-.171.846c-.242 1.128-1.323 6.855-1.479 8.085c0 .093 0-.096 0 0A149 149 0 0 0 1.3 135.717v.662c.086 98.661 106.944 160.23 192.344 110.825a128.17 128.17 0 0 0 62.12-89.153c.215-1.653.39-3.29.582-4.96a131.8 131.8 0 0 0-8.313-64.378m-12.715 6.583l.024.136z"
      />
    </svg>
  );
};
