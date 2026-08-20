"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

import { cn } from "@/lib/utils";

/** Put this on the hover target that wraps the icon (Button, Link, etc.). */
export const ARROW_RIGHT_GROUP_CLASS = "group/arrow-right";

export interface ArrowRightIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface ArrowRightIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const PATH_VARIANTS: Variants = {
  normal: { d: "M5 12h14" },
  animate: {
    d: ["M5 12h14", "M5 12h9", "M5 12h14"],
    transition: {
      duration: 0.4,
    },
  },
};

const SECONDARY_PATH_VARIANTS: Variants = {
  normal: { d: "m12 5 7 7-7 7", translateX: 0 },
  animate: {
    d: "m12 5 7 7-7 7",
    translateX: [0, -3, 0],
    transition: {
      duration: 0.4,
    },
  },
};

function closestArrowRightGroup(node: Element): Element | null {
  let current = node.parentElement;

  while (current) {
    if (current.classList.contains(ARROW_RIGHT_GROUP_CLASS)) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

const ArrowRightIcon = forwardRef<ArrowRightIconHandle, ArrowRightIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
    const controls = useAnimation();
    const rootRef = useRef<HTMLDivElement>(null);
    const isControlledRef = useRef(false);
    const boundToGroupRef = useRef(false);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;

      return {
        startAnimation: () => controls.start("animate"),
        stopAnimation: () => controls.start("normal"),
      };
    });

    useEffect(() => {
      const node = rootRef.current;
      if (!node || isControlledRef.current) {
        return;
      }

      const group = closestArrowRightGroup(node);
      if (!group) {
        return;
      }

      boundToGroupRef.current = true;

      const start = () => {
        void controls.start("animate");
      };
      const stop = () => {
        void controls.start("normal");
      };

      group.addEventListener("mouseenter", start);
      group.addEventListener("mouseleave", stop);

      return () => {
        boundToGroupRef.current = false;
        group.removeEventListener("mouseenter", start);
        group.removeEventListener("mouseleave", stop);
      };
    }, [controls]);

    const handleMouseEnter = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        onMouseEnter?.(e);
        if (isControlledRef.current || boundToGroupRef.current) {
          return;
        }
        void controls.start("animate");
      },
      [controls, onMouseEnter]
    );

    const handleMouseLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        onMouseLeave?.(e);
        if (isControlledRef.current || boundToGroupRef.current) {
          return;
        }
        void controls.start("normal");
      },
      [controls, onMouseLeave]
    );

    return (
      <div
        ref={rootRef}
        className={cn(className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        <svg
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <motion.path
            animate={controls}
            d="M5 12h14"
            variants={PATH_VARIANTS}
          />
          <motion.path
            animate={controls}
            d="m12 5 7 7-7 7"
            variants={SECONDARY_PATH_VARIANTS}
          />
        </svg>
      </div>
    );
  }
);

ArrowRightIcon.displayName = "ArrowRightIcon";

export { ArrowRightIcon };
