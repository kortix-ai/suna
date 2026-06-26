"use client";

import {
  forwardRef,
  useRef,
  useState,
  useEffect,
  useCallback,
  type ComponentProps,
} from "react";
import { motion, useMotionValue, animate } from "motion/react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";
import { spring } from "@/lib/springs";

type SwitchProps = Omit<ComponentProps<typeof SwitchPrimitive.Root>, "asChild"> & {
  label?: string;
};

const TRACK_WIDTH = 34;
const TRACK_HEIGHT = 20;
const THUMB_SIZE = 16;
const THUMB_OFFSET = 2;
const THUMB_TRAVEL = TRACK_WIDTH - THUMB_SIZE - THUMB_OFFSET * 2;
const PILL_EXTEND = 2;
const PRESS_EXTEND = 4;
const PRESS_SHRINK = 4;
const DRAG_DEAD_ZONE = 2;

const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      label,
      checked,
      onCheckedChange,
      disabled = false,
      className,
      id,
      ...props
    },
    ref
  ) => {
    const hasMounted = useRef(false);
    const [hovered, setHovered] = useState(false);
    const [pressed, setPressed] = useState(false);
    const isChecked = checked ?? false;

    const dragging = useRef(false);
    const didDrag = useRef(false);
    const pointerStart = useRef<{
      clientX: number;
      originX: number;
    } | null>(null);

    const motionX = useMotionValue(
      isChecked ? THUMB_OFFSET + THUMB_TRAVEL : THUMB_OFFSET
    );

    useEffect(() => {
      hasMounted.current = true;
    }, []);

    const thumbWidth = pressed
      ? THUMB_SIZE + PRESS_EXTEND
      : hovered
        ? THUMB_SIZE + PILL_EXTEND
        : THUMB_SIZE;
    const thumbHeight = pressed ? THUMB_SIZE - PRESS_SHRINK : THUMB_SIZE;
    const thumbY = pressed ? THUMB_OFFSET + PRESS_SHRINK / 2 : THUMB_OFFSET;
    const extraWidth = thumbWidth - THUMB_SIZE;
    const thumbX = isChecked
      ? THUMB_OFFSET + THUMB_TRAVEL - extraWidth
      : THUMB_OFFSET;

    useEffect(() => {
      if (dragging.current) return;
      if (!hasMounted.current) {
        motionX.set(thumbX);
      } else {
        animate(motionX, thumbX, spring.moderate);
      }
    }, [thumbX, motionX]);

    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLButtonElement>) => {
        if (disabled) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        setPressed(true);
        dragging.current = false;
        didDrag.current = false;
        pointerStart.current = {
          clientX: e.clientX,
          originX: motionX.get(),
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      [disabled, motionX]
    );

    const handlePointerMove = useCallback(
      (e: React.PointerEvent<HTMLButtonElement>) => {
        if (!pointerStart.current) return;
        const delta = e.clientX - pointerStart.current.clientX;

        if (!dragging.current) {
          if (Math.abs(delta) < DRAG_DEAD_ZONE) return;
          dragging.current = true;
        }

        const dragMin = THUMB_OFFSET;
        const pressedThumbWidth = THUMB_SIZE + PRESS_EXTEND;
        const dragMax = TRACK_WIDTH - THUMB_OFFSET - pressedThumbWidth;
        const rawX = pointerStart.current.originX + delta;
        motionX.set(Math.max(dragMin, Math.min(dragMax, rawX)));
      },
      [motionX]
    );

    const handlePointerUp = useCallback(() => {
      if (!pointerStart.current) return;
      setPressed(false);

      if (dragging.current) {
        didDrag.current = true;
        dragging.current = false;

        const currentX = motionX.get();
        const dragMin = THUMB_OFFSET;
        const pressedThumbWidth = THUMB_SIZE + PRESS_EXTEND;
        const dragMax = TRACK_WIDTH - THUMB_OFFSET - pressedThumbWidth;
        const midpoint = (dragMin + dragMax) / 2;

        const shouldBeOn = currentX > midpoint;

        if (shouldBeOn !== isChecked) {
          onCheckedChange?.(shouldBeOn);
        } else {
          const snapTarget = isChecked
            ? THUMB_OFFSET + THUMB_TRAVEL
            : THUMB_OFFSET;
          animate(motionX, snapTarget, spring.moderate);
        }

        requestAnimationFrame(() => {
          didDrag.current = false;
        });
      }

      pointerStart.current = null;
    }, [isChecked, onCheckedChange, motionX]);

    const switchControl = (
      <SwitchPrimitive.Root
        ref={ref}
        id={id}
        checked={checked}
        disabled={disabled}
        tabIndex={0}
        className={cn(
          "relative shrink-0 rounded-full outline-none cursor-pointer touch-none",
          "transition-colors duration-80",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          !label && className
        )}
        style={{
          width: TRACK_WIDTH,
          height: TRACK_HEIGHT,
          backgroundColor: isChecked
            ? hovered
              ? "var(--kortix-blue)"
              : "var(--kortix-blue)"
            : hovered
              ? "color-mix(in oklab, var(--accent), rgb(var(--overlay)) 10%)"
              : "var(--accent)",
        }}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onCheckedChange={(nextChecked) => {
          if (didDrag.current) return;
          onCheckedChange?.(nextChecked);
        }}
        {...props}
      >
        <SwitchPrimitive.Thumb asChild>
          <motion.span
            className="absolute top-0 left-0 block rounded-full bg-white shadow-sm"
            initial={false}
            style={{ x: motionX }}
            animate={{
              y: thumbY,
              width: thumbWidth,
              height: thumbHeight,
            }}
            transition={hasMounted.current ? spring.moderate : { duration: 0 }}
          />
        </SwitchPrimitive.Thumb>
      </SwitchPrimitive.Root>
    );

    if (!label) {
      return switchControl;
    }

    return (
      <div
        className={cn(
          "relative z-10 flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none",
          disabled && "opacity-50 pointer-events-none",
          className
        )}
      >
        {switchControl}
        <span
          className={cn(
            "text-[13px] transition-[color] duration-80",
            isChecked ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
        </span>
      </div>
    );
  }
);

Switch.displayName = "Switch";

export { Switch };
export type { SwitchProps };
