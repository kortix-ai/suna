'use client';

import { Slider as SliderPrimitive } from 'radix-ui';
import * as React from 'react';

import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';

function NativeSlider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  tooltip,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** Shown in a Hint above the thumb while hovering it. */
  tooltip?: React.ReactNode;
}) {
  const _values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max]),
    [value, defaultValue, min, max],
  );

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        'relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="bg-kortix-base/60 relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="bg-kortix-blue absolute select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => {
        const thumb = (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            className="border-ring ring-ring/50 hit-area-4 relative block size-3.5 shrink-0 rounded-full border bg-white transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50"
          />
        );
        if (tooltip == null) return <React.Fragment key={index}>{thumb}</React.Fragment>;
        return (
          <Hint key={index} side="top" label={tooltip}>
            {thumb}
          </Hint>
        );
      })}
    </SliderPrimitive.Root>
  );
}

export { NativeSlider };
