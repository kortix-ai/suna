"use client"

import { motion, MotionStyle, Transition } from "framer-motion"

import { cn } from "@/lib/utils"

interface BorderBeamProps {
    /**
     * The size of the border beam (length of the glowing trail).
     */
    size?: number
    /**
     * The duration of the border beam animation in seconds.
     */
    duration?: number
    /**
     * The delay before starting the animation.
     */
    delay?: number
    /**
     * The color of the border beam from.
     */
    colorFrom?: string
    /**
     * The color of the border beam to.
     */
    colorTo?: string
    /**
     * The motion transition of the border beam.
     */
    transition?: Transition
    /**
     * The class name of the border beam.
     */
    className?: string
    /**
     * The style of the border beam.
     */
    style?: React.CSSProperties
    /**
     * Whether to reverse the animation direction.
     */
    reverse?: boolean
    /**
     * The initial offset position (0-100).
     */
    initialOffset?: number
    /**
     * The border width of the beam.
     */
    borderWidth?: number
    /**
     * The border radius for the path. Should match the parent element's border radius.
     * Defaults to 12 (matches rounded-xl).
     */
    borderRadius?: number
}

export const BorderBeam = ({
    className,
    size = 50,
    delay = 0,
    duration = 6,
    colorFrom = "#ffaa40",
    colorTo = "#9c40ff",
    transition,
    style,
    reverse = false,
    initialOffset = 0,
    borderWidth = 1,
    borderRadius = 12,
}: BorderBeamProps) => {
    return (
        <div
            className="pointer-events-none absolute inset-0 rounded-[inherit] border-(length:--border-beam-width) border-transparent [mask-image:linear-gradient(transparent,transparent),linear-gradient(#000,#000)] [mask-composite:intersect] [mask-clip:padding-box,border-box]"
            style={
                {
                    "--border-beam-width": `${borderWidth}px`,
                } as React.CSSProperties
            }
        >
            <motion.div
                className={cn(
                    "absolute will-change-transform",
                    "bg-gradient-to-l from-[var(--color-from)] via-[var(--color-to)] to-transparent",
                    className
                )}
                style={
                    {
                        width: size,
                        height: size,
                        offsetPath: `rect(0 auto auto 0 round ${borderRadius}px)`,
                        "--color-from": colorFrom,
                        "--color-to": colorTo,
                        transform: "translateZ(0)", // Force GPU acceleration
                        backfaceVisibility: "hidden",
                        ...style,
                    } as MotionStyle
                }
                initial={{ offsetDistance: `${initialOffset}%` }}
                animate={{
                    offsetDistance: reverse
                        ? [`${100 - initialOffset}%`, `${-initialOffset}%`]
                        : [`${initialOffset}%`, `${100 + initialOffset}%`],
                }}
                transition={{
                    repeat: Infinity,
                    ease: "linear",
                    duration,
                    delay: -delay,
                    repeatType: "loop",
                    ...transition,
                }}
            />
        </div>
    )
}
