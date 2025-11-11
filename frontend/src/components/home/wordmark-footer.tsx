'use client';

import { useRef, useState, useEffect } from 'react';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/utils';

export function WordmarkFooter() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
    const [isHovered, setIsHovered] = useState(false);
    const isMobile = useIsMobile();

    useEffect(() => {
        if (isMobile) return; // Skip mouse tracking on mobile

        const handleGlobalMouseMove = (e: MouseEvent) => {
            if (!containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            setMousePosition({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
            });
        };

        window.addEventListener('mousemove', handleGlobalMouseMove);
        return () => window.removeEventListener('mousemove', handleGlobalMouseMove);
    }, [isMobile]);

    return (
        <section className="w-full px-6">
            <div
                ref={containerRef}
                onMouseEnter={() => !isMobile && setIsHovered(true)}
                onMouseLeave={() => !isMobile && setIsHovered(false)}
                className="relative w-full mx-auto overflow-hidden md:px-12 lg:px-16 md:pt-32"
                style={{
                    // @ts-expect-error - CSS custom properties are not in CSSProperties type
                    '--mouse-x': `${mousePosition.x}px`,
                    '--mouse-y': `${mousePosition.y}px`,
                }}
            >
                {/* Background */}
                <div className="absolute inset-0 bg-background" />

                {/* Wordmark - hidden by spotlight on hover (desktop) or static gradient (mobile) */}
                <div className="relative w-full md:aspect-[1150/344] aspect-square p-0 sm:p-8 md:p-12 lg:p-16">
                    <div
                        className="absolute inset-0 sm:p-8 md:p-12 lg:p-16"
                        style={{
                            maskImage: isMobile
                                ? 'linear-gradient(to bottom, black 0%, black 20%, transparent 100%, transparent 50%, black 100%, black 10%)'
                                : isHovered
                                    ? `radial-gradient(1500px circle at var(--mouse-x) var(--mouse-y), transparent, black 40%)`
                                    : 'none',
                            WebkitMaskImage: isMobile
                                ? 'linear-gradient(to bottom, black 0%, black 20%, transparent 100%, transparent 50%, black 100%, black 10%)'
                                : isHovered
                                    ? `radial-gradient(1500px circle at var(--mouse-x) var(--mouse-y), transparent, black 40%)`
                                    : 'none',
                            transition: isMobile ? 'none' : 'mask-image 0.3s, -webkit-mask-image 0.3s',
                        }}
                    >
                        <div className="relative w-full h-full" style={{ isolation: 'isolate' }}>
                            {/* Base wordmark - symbol for mobile, wordmark for desktop */}
                            <div className="md:hidden absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: '280px', height: '280px' }}>
                                <Image
                                    src="/kortix-symbol.svg"
                                    alt="Kortix"
                                    fill
                                    className="object-contain invert dark:invert-0 opacity-15"
                                    priority
                                    style={{ mixBlendMode: 'normal' }}
                                />
                                {/* Grain texture overlay - clipped to symbol shape */}
                                <div
                                    className="absolute inset-0 pointer-events-none"
                                    style={{
                                        backgroundImage: 'url(/grain-texture.png)',
                                        backgroundSize: '100px 100px',
                                        backgroundRepeat: 'repeat',
                                        mixBlendMode: 'multiply',
                                        opacity: 0.6,
                                        maskImage: 'url(/kortix-symbol.svg)',
                                        WebkitMaskImage: 'url(/kortix-symbol.svg)',
                                        maskSize: 'contain',
                                        WebkitMaskSize: 'contain',
                                        maskRepeat: 'no-repeat',
                                        WebkitMaskRepeat: 'no-repeat',
                                        maskPosition: 'center',
                                        WebkitMaskPosition: 'center',
                                    }}
                                />
                            </div>
                            <Image
                                src="/wordmark.svg"
                                alt="Kortix"
                                fill
                                className="object-contain dark:invert hidden md:block"
                                priority
                                style={{ mixBlendMode: 'normal' }}
                            />
                            {/* Grain texture overlay - clipped to wordmark shape */}
                            <div
                                className="absolute inset-0 pointer-events-none md:block hidden"
                                style={{
                                    backgroundImage: 'url(/grain-texture.png)',
                                    backgroundSize: '100px 100px',
                                    backgroundRepeat: 'repeat',
                                    mixBlendMode: 'multiply',
                                    opacity: 0.6,
                                    maskImage: 'url(/wordmark.svg)',
                                    WebkitMaskImage: 'url(/wordmark.svg)',
                                    maskSize: 'contain',
                                    WebkitMaskSize: 'contain',
                                    maskRepeat: 'no-repeat',
                                    WebkitMaskRepeat: 'no-repeat',
                                    maskPosition: 'center',
                                    WebkitMaskPosition: 'center',
                                }}
                            />
                        </div>
                    </div>

                    {/* Hidden wordmark for layout (maintains aspect ratio) */}
                    <div className="relative w-full h-full opacity-0">
                        <div className="relative w-full h-full md:hidden">
                            <Image
                                src="/kortix-symbol.svg"
                                alt="Kortix"
                                fill
                                className="object-contain"
                                priority
                            />
                        </div>
                        <Image
                            src="/wordmark.svg"
                            alt="Kortix"
                            fill
                            className="object-contain hidden md:block"
                            priority
                        />
                    </div>
                </div>
            </div>
        </section>
    );
}

