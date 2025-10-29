'use client';

import React from 'react';
import { GrainText } from '@/components/ui/grain-text';
import { FirstBentoAnimation } from '@/components/home/first-bento-animation';
import { SecondBentoAnimation } from '@/components/home/second-bento-animation';
import { ThirdBentoAnimation } from '@/components/home/third-bento-animation';

const steps = [
    {
        step: 'Step 1',
        title: 'Describe what you need',
        description: 'Tell the AI Worker what job you want it to do. Your Worker will set up the exact workflow you described.',
        animation: <FirstBentoAnimation />,
    },
    {
        step: 'Step 2',
        title: 'Connect your tools',
        description: 'Link your Worker to the apps and services you already use — like Gmail, Google Calendar, or your reporting tools.',
        animation: <SecondBentoAnimation />,
    },
    {
        step: 'Step 3',
        title: 'Let it run',
        description: 'Watch your Worker handle complex tasks and workflows with advanced AI reasoning.',
        animation: <ThirdBentoAnimation />,
    },
];

export function PersonalizationSection() {
    return (
        <>
            {/* Header section */}
            <section className="min-h-screen w-full flex items-center justify-center snap-start snap-always">
                <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-4">
                    <h2 className="text-3xl sm:text-4xl md:text-5xl font-medium leading-tight">
                        Personalize your AI Worker in{' '}
                        <span className="text-muted-foreground">3 Simple Steps</span>
                    </h2>
                    <GrainText className="text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto" grainOpacity={100}>
                        Create an AI Worker that can handle tasks for you — from emails to reports — in just a few minutes.
                    </GrainText>
                </div>
            </section>

            {/* Step cards */}
            {steps.map((step, i) => (
                <section
                    key={i}
                    className="min-h-screen w-full flex items-center justify-center snap-start snap-always"
                >
                    <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
                        <div className="w-full space-y-4 sm:space-y-6 md:space-y-8">
                            {/* Card with border and padding */}
                            <div className="border border-border rounded-2xl sm:rounded-3xl bg-background p-4 sm:p-6 md:p-8">
                                {/* Animation inside card */}
                                <div className="w-full aspect-[16/9] relative overflow-hidden rounded-xl sm:rounded-2xl bg-muted flex items-center justify-center">
                                    {step.animation}
                                </div>
                            </div>

                            {/* Below card content */}
                            <div className="flex flex-col sm:flex-row items-start justify-between gap-4 sm:gap-6 md:gap-8">
                                <div className="flex-1 space-y-2 sm:space-y-3">
                                    <div className="space-y-1">
                                        {/* Step label */}
                                        <p className="text-sm sm:text-base text-muted-foreground font-medium">
                                            {step.step}
                                        </p>
                                        {/* Title */}
                                        <h3 className="text-xl sm:text-2xl md:text-[32px] font-medium leading-tight">
                                            {step.title}
                                        </h3>
                                    </div>
                                    {/* Description */}
                                    <GrainText className="text-sm sm:text-base md:text-[16px] text-muted-foreground" grainOpacity={100}>
                                        {step.description}
                                    </GrainText>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>
            ))}
        </>
    );
}
