'use client';

import { GrainText } from '@/components/ui/grain-text';
import { Presentation, Code, Shield, Headphones } from 'lucide-react';
import { CheckCircle2 } from 'lucide-react';
import React from 'react';

const workers = [
    {
        title: 'Presenter',
        icon: Presentation,
        iconBg: '#FFD2D2',
        iconColor: '#B91C1C',
        capabilities: ['Create presentations', 'Summarize reports', 'Visualize data']
    },
    {
        title: 'Developer',
        icon: Code,
        iconBg: '#F5DEBA',
        iconColor: '#B45309',
        capabilities: ['Write code', 'Debug issues', 'Build tools']
    },
    {
        title: 'Mathematician',
        icon: Shield,
        iconBg: '#CFE1FF',
        iconColor: '#1D4ED8',
        capabilities: ['Solve equations', 'Prove theorems', 'Explain concepts']
    },
    {
        title: 'Therapist',
        icon: Headphones,
        iconBg: '#B4E4BE',
        iconColor: '#059669',
        capabilities: ['Listen actively', 'Reduce stress', 'Support growth']
    }
];

export function AIWorkerSection() {
    return (
        <section className="py-16 px-4 w-full">
            <div className="w-full max-w-7xl mx-auto">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                    {workers.map((worker, i) => (
                        <div
                            key={i}
                            className="bg-background border border-border rounded-3xl p-6 flex flex-col"
                        >
                            {/* Icon container */}
                            <div
                                className="rounded-3xl w-full flex items-center justify-center relative overflow-hidden mb-6"
                                style={{
                                    backgroundColor: worker.iconBg,
                                    height: 160,
                                }}
                            >
                                <worker.icon
                                    className="relative z-10"
                                    style={{ color: worker.iconColor, width: 56, height: 56 }}
                                />
                                <div
                                    className="absolute inset-0 z-20 pointer-events-none"
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

                            {/* Title */}
                            <h3 className="text-2xl font-semibold mb-4">{worker.title}</h3>

                            {/* Capabilities list */}
                            <ul className="space-y-3 flex-1">
                                {worker.capabilities.map((capability, idx) => (
                                    <li key={idx} className="flex items-center gap-2 text-muted-foreground">
                                        <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-muted-foreground" />
                                        <span className="text-base">{capability}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}