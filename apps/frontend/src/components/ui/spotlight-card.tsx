'use client';

import React, { useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface SpotlightCardProps {
    children: React.ReactNode;
    className?: string;
    spotlightColor?: string;
}

export function SpotlightCard({
    children,
    className,
    spotlightColor,
}: SpotlightCardProps) {
    const cardRef = useRef<HTMLDivElement>(null);
    const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
    const [isHovered, setIsHovered] = useState(false);

    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!cardRef.current) return;
        const rect = cardRef.current.getBoundingClientRect();
        setMousePosition({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        });
    };

    // Use custom color if provided, otherwise use CSS variables for light/dark mode
    const spotlightBg = spotlightColor
        ? `radial-gradient(600px circle at var(--mouse-x) var(--mouse-y), ${spotlightColor}, transparent 40%)`
        : undefined;

    const borderGlowBg = spotlightColor
        ? `radial-gradient(400px circle at var(--mouse-x) var(--mouse-y), ${spotlightColor.replace('0.1', '0.2')}, transparent 40%)`
        : undefined;

    return (
        <div
            ref={cardRef}
            onMouseMove={handleMouseMove}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            className={cn('relative overflow-hidden rounded-2xl', className)}
            style={{
                // @ts-expect-error - CSS custom properties are not in CSSProperties type
                '--mouse-x': `${mousePosition.x}px`,
                '--mouse-y': `${mousePosition.y}px`,
            }}
        >
            {/* Spotlight effect */}
            {isHovered && (
                <div
                    className={cn(
                        'pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300',
                        !spotlightColor && 'bg-[radial-gradient(600px_circle_at_var(--mouse-x)_var(--mouse-y),rgba(0,0,0,0.06),transparent_40%)] dark:bg-[radial-gradient(600px_circle_at_var(--mouse-x)_var(--mouse-y),rgba(255,255,255,0.1),transparent_40%)]'
                    )}
                    style={{
                        opacity: isHovered ? 1 : 0,
                        ...(spotlightBg && { background: spotlightBg }),
                    }}
                />
            )}

            {/* Border glow */}
            {isHovered && (
                <div
                    className={cn(
                        'pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-300',
                        !spotlightColor && 'bg-[radial-gradient(400px_circle_at_var(--mouse-x)_var(--mouse-y),rgba(0,0,0,0.1),transparent_40%)] dark:bg-[radial-gradient(400px_circle_at_var(--mouse-x)_var(--mouse-y),rgba(255,255,255,0.2),transparent_40%)]'
                    )}
                    style={{
                        opacity: isHovered ? 1 : 0,
                        ...(borderGlowBg && { background: borderGlowBg }),
                        mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
                        WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
                        maskComposite: 'exclude',
                        WebkitMaskComposite: 'xor',
                        padding: '1px',
                    }}
                />
            )}

            {/* Content */}
            <div className="relative z-10">{children}</div>
        </div>
    );
}
