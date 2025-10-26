'use client';

import React from 'react';
import { GrainText } from '@/components/ui/grain-text';

const slides = [
    {
        title: 'Presentations',
        color: '#FFD2D2',
        textColor: '#B91C1C',
        subtitle: 'Polished, client-ready presentations',
        description: 'Tell the AI Worker what job you want it to do.',
    },
    {
        title: 'Spreadsheets',
        color: '#F5DEBA',
        textColor: '#B45309',
        subtitle: 'Automated data analysis and reporting',
        description: 'Tell the AI Worker what job you want it to do.',
    },
    {
        title: 'Design',
        color: '#CFE1FF',
        textColor: '#1D4ED8',
        subtitle: 'Professional designs in minutes',
        description: 'Tell the AI Worker what job you want it to do.',
    },
    {
        title: 'Docs',
        color: '#B4E4BE',
        textColor: '#059669',
        subtitle: 'Clear, comprehensive documentation',
        description: 'Tell the AI Worker what job you want it to do.',
    },
    {
        title: 'Data Visualization',
        color: '#E9D5FF',
        textColor: '#7C3AED',
        subtitle: 'Beautiful charts and insights',
        description: 'Tell the AI Worker what job you want it to do.',
    },
];

export function SlidesSection() {
    return (
        <>
            {slides.map((slide, i) => (
                <section
                    key={i}
                    className="min-h-screen w-full flex items-center justify-center snap-start snap-always"
                >
                    <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
                        <div className="w-full space-y-4 sm:space-y-6 md:space-y-8">
                            {/* Header - Responsive: 24px mobile, 32px tablet, 43px desktop */}
                            <h2 className="text-2xl sm:text-3xl md:text-[43px] font-medium leading-tight text-center">
                                24/7 AI Worker for{' '}
                                <span style={{ color: slide.textColor }}>{slide.title}</span>
                            </h2>

                            {/* Card with border and padding - responsive padding */}
                            <div className="border border-border rounded-2xl sm:rounded-3xl bg-background p-3 sm:p-4 md:p-6">
                                {/* Image inside card */}
                                <div
                                    className="w-full aspect-[16/9] relative overflow-hidden rounded-xl sm:rounded-2xl"
                                    style={{ backgroundColor: slide.color }}
                                >
                                    <div className="w-full h-full flex items-center justify-center">
                                        <div className="text-center">
                                            <div
                                                className="text-4xl sm:text-6xl md:text-7xl lg:text-8xl font-medium opacity-10"
                                                style={{ color: slide.textColor }}
                                            >
                                                {slide.title}
                                            </div>
                                        </div>
                                    </div>
                                    <div
                                        className="absolute inset-0 z-10 pointer-events-none"
                                        style={{
                                            backgroundImage: 'url(/grain-texture.png)',
                                            backgroundSize: 'cover',
                                            backgroundPosition: 'center',
                                            backgroundRepeat: 'repeat',
                                            opacity: 1,
                                            mixBlendMode: 'overlay',
                                        }}
                                    />
                                </div>
                            </div>

                            {/* Below card content - responsive flex direction */}
                            <div className="flex flex-col sm:flex-row items-start justify-between gap-4 sm:gap-6 md:gap-8">
                                <div className="flex-1 space-y-1 sm:space-y-2">
                                    {/* Title - Responsive: 20px mobile, 24px tablet, 32px desktop */}
                                    <h3 className="text-xl sm:text-2xl md:text-[32px] font-medium leading-tight">
                                        {slide.subtitle}
                                    </h3>
                                    {/* Description - Responsive: 14px mobile, 16px desktop */}
                                    <GrainText className="text-sm sm:text-base md:text-[16px] text-muted-foreground" grainOpacity={100}>
                                        {slide.description}
                                    </GrainText>
                                </div>

                                {/* Button - Responsive size */}
                                <button className="bg-foreground text-background px-4 sm:px-5 md:px-6 py-2 sm:py-2.5 md:py-3 rounded-full text-sm sm:text-base font-medium hover:opacity-90 transition-opacity flex items-center gap-2 whitespace-nowrap w-full sm:w-auto justify-center">
                                    Get Started
                                    <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 16 16"
                                        fill="none"
                                        xmlns="http://www.w3.org/2000/svg"
                                        className="sm:w-4 sm:h-4"
                                    >
                                        <path
                                            d="M6 3L11 8L6 13"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </svg>
                                </button>
                            </div>
                        </div>
                    </div>
                </section>
            ))}
        </>
    );
}
