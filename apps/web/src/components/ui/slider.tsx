'use client';

import * as SliderPrimitive from '@radix-ui/react-slider';
import * as React from 'react';

import { cn } from '@/lib/utils';

type SliderProps = React.ComponentProps<typeof SliderPrimitive.Root> & {
  /**
   * Accessible name for the thumb(s). Radix renders each thumb as the
   * `role="slider"` node, so a name on the root is never announced — it has to
   * land here. Pass an array to name each thumb of a range slider.
   */
  thumbLabel?: string | string[];
  /** Announced in place of the raw number (`aria-valuetext`), e.g. `40%`, `0.85`. */
  formatValue?: (value: number, index: number) => string;
};

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  onValueChange,
  thumbLabel,
  formatValue,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  ...props
}: SliderProps) {
  const [uncontrolledValues, setUncontrolledValues] = React.useState<number[]>(() =>
    Array.isArray(defaultValue) ? defaultValue : [min, max],
  );
  const values = Array.isArray(value) ? value : uncontrolledValues;

  const handleValueChange = React.useCallback(
    (next: number[]) => {
      setUncontrolledValues(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );

  const labelFor = (index: number) => {
    if (Array.isArray(thumbLabel)) return thumbLabel[index];
    const base = thumbLabel ?? ariaLabel;
    if (!base || values.length < 2) return base;
    if (index === 0) return `${base} minimum`;
    if (index === values.length - 1) return `${base} maximum`;
    return `${base} ${index + 1}`;
  };

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      onValueChange={handleValueChange}
      className={cn(
        'group/slider relative flex w-full cursor-pointer touch-none items-center select-none',
        'data-disabled:pointer-events-none data-disabled:cursor-default data-disabled:opacity-50',
        'data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          // Hairline rail: the whole control is one thin ink stroke.
          'bg-primary/10 relative grow overflow-hidden rounded-full',
          'data-[orientation=horizontal]:h-2 data-[orientation=horizontal]:w-full',
          'data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1',
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            'bg-primary absolute rounded-full data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full',
          )}
        />
      </SliderPrimitive.Track>
      {values.map((_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          aria-label={labelFor(index)}
          aria-labelledby={ariaLabelledBy}
          aria-valuetext={formatValue ? formatValue(values[index] ?? min, index) : undefined}
          className={cn(
            // Caret thumb: a short vertical bar in the same ink as the fill, so
            // the range reads as one continuous stroke that rises into a handle.
            'bg-primary block h-4 w-2 shrink-0 rounded-full',
            'group-data-[orientation=vertical]/slider:h-1 group-data-[orientation=vertical]/slider:w-4',
            // 44x51px touch target without shifting layout.
            'hit-area-x-4 hit-area-y-5 cursor-pointer',
            // `scale` composes with Radix's inline `translate(-50%)` (Tailwind v4
            // uses the standalone `scale` property), so the bar grows around its
            // own center without breaking thumb positioning.
            'duration-fast ease-default transition-[scale,box-shadow] outline-none',
            'active:scale-x-150 active:scale-y-125',
            // Focus: accent ring with a surface-coloured gap that punches through
            // the track, so the indicator reads as "on the thumb".
            // `:focus`, not `:focus-visible` — Chrome resolves focus-visible once, at
            // focus time, so a thumb grabbed by pointer would stay unringed for the
            // rest of the interaction even after the user switches to arrow keys.
            'focus:ring-ring focus:ring-offset-background focus:ring-2 focus:ring-offset-2',
            // Forced-colors mode strips box-shadow rings; a transparent outline is
            // repainted there as a real system-coloured focus ring.
            'focus:outline-2 focus:outline-offset-2 focus:outline-transparent focus:outline-solid',
            'data-disabled:pointer-events-none data-disabled:cursor-default',
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
