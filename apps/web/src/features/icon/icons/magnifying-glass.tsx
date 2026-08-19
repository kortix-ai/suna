'use client';

import { cn } from '@/lib/utils';

export const MagnifyingGlass = ({ className }: { className?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      baseProfile="basic"
      className={cn('size-4', className)}
    >
      <linearGradient
        id="hBcdOHj0tpNmQcPjQ7iiFa"
        x1="4.696"
        x2="21.274"
        y1="4.696"
        y2="21.274"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="currentColor" stopOpacity=".6" />
        <stop offset="1" stopColor="currentColor" stopOpacity=".3" />
      </linearGradient>
      <path
        fill="url(#hBcdOHj0tpNmQcPjQ7iiFa)"
        d="M21.414,18.586c-0.287-0.287-1.942-1.942-2.801-2.801l0,0C19.487,14.398,20,12.76,20,11 c0-4.971-4.029-9-9-9s-9,4.029-9,9c0,4.971,4.029,9,9,9c1.761,0,3.398-0.513,4.785-1.387c0,0,0,0,0,0 c0.859,0.859,2.514,2.514,2.801,2.801c0.781,0.781,2.047,0.781,2.828,0C22.195,20.633,22.195,19.367,21.414,18.586z M11,16 c-2.761,0-5-2.239-5-5s2.239-5,5-5s5,2.239,5,5S13.761,16,11,16z"
      />
      <g>
        <linearGradient
          id="hBcdOHj0tpNmQcPjQ7iiFb"
          x1="4.636"
          x2="21.414"
          y1="4.636"
          y2="21.414"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="currentColor" stopOpacity=".6" />
          <stop offset=".493" stopColor="currentColor" stopOpacity="0" />
          <stop offset=".997" stopColor="currentColor" stopOpacity=".3" />
        </linearGradient>
        <path
          fill="url(#hBcdOHj0tpNmQcPjQ7iiFb)"
          d="M11,2.5c4.687,0,8.5,3.813,8.5,8.5 c0,1.595-0.453,3.158-1.31,4.518l-0.213,0.338l0.282,0.282l2.801,2.801C21.344,19.223,21.5,19.599,21.5,20 c0,0.401-0.156,0.777-0.439,1.061C20.777,21.344,20.401,21.5,20,21.5s-0.777-0.156-1.061-0.439l-2.801-2.801l-0.282-0.282 l-0.338,0.213C14.158,19.047,12.595,19.5,11,19.5c-4.687,0-8.5-3.813-8.5-8.5S6.313,2.5,11,2.5 M11,16.5 c3.033,0,5.5-2.467,5.5-5.5S14.033,5.5,11,5.5S5.5,7.967,5.5,11S7.967,16.5,11,16.5 M11,2c-4.971,0-9,4.029-9,9 c0,4.971,4.029,9,9,9c1.761,0,3.398-0.513,4.785-1.387c0,0,0,0,0,0c0,0,0,0,0,0c0,0,0,0,0,0c0.859,0.859,2.514,2.514,2.801,2.801 C18.976,21.805,19.488,22,20,22c0.512,0,1.024-0.195,1.414-0.586c0.781-0.781,0.781-2.047,0-2.828 c-0.287-0.287-1.942-1.942-2.801-2.801C19.487,14.398,20,12.76,20,11C20,6.029,15.971,2,11,2L11,2z M11,16c-2.761,0-5-2.239-5-5 c0-2.761,2.239-5,5-5c2.761,0,5,2.239,5,5C16,13.761,13.761,16,11,16L11,16z"
        />
      </g>
    </svg>
  );
};
