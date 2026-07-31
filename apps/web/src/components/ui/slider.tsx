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
        'relative flex w-full cursor-pointer touch-none items-center select-none',
        'data-disabled:pointer-events-none data-disabled:cursor-default data-disabled:opacity-50',
        'data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          'bg-primary/20 relative grow overflow-hidden rounded-full',
          'data-[orientation=horizontal]:h-4 data-[orientation=horizontal]:w-full',
          'data-[orientation=vertical]:h-full data-[orientation=vertical]:w-4',
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            'bg-primary absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full',
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
            // Surface-coloured knob with an ink outline: the only fill that clears
            // 3:1 against BOTH the filled range and the unfilled track.
            'bg-background border-primary block size-[15px] shrink-0 rounded-full border-2 shadow-xs',
            // 44x51px touch target without shifting layout.
            'hit-area-x-4 hit-area-y-5 cursor-pointer',
            'transition-[box-shadow] duration-fast ease-default',
            // Hover / drag: soft neutral halo hugging the knob.
            'outline-none hover:ring-4 hover:ring-primary/15',
            'active:ring-4 active:ring-primary/25',
            // Focus: accent ring with a surface-coloured gap that punches through
            // the track, so the indicator reads as "on the thumb".
            // `:focus`, not `:focus-visible` — Chrome resolves focus-visible once, at
            // focus time, so a thumb grabbed by pointer would stay unringed for the
            // rest of the interaction even after the user switches to arrow keys.
            'focus:ring-ring focus:ring-offset-background focus:ring-2 focus:ring-offset-2',
            // Forced-colors mode strips box-shadow rings; a transparent outline is
            // repainted there as a real system-coloured focus ring.
            'focus:outline-solid focus:outline-2 focus:outline-offset-2 focus:outline-transparent',
            'data-disabled:pointer-events-none data-disabled:cursor-default',
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
