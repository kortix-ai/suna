'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/utils';
import { GrainText } from '@/components/ui/grain-text';
import { GrainIcon } from '@/components/ui/grain-icon';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DynamicIcon } from 'lucide-react/dynamic';
import { Computer } from 'lucide-react';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

interface WorkerType {
    id: string;
    iconName: string;
    iconColor: string;
    backgroundColor: string;
    borderColor: string;
    title: string;
    description: string;
    capabilities: string[];
    image: string;
    imageAlt: string;
    fileType: string;
}

const workers: WorkerType[] = [
    {
        id: 'images',
        iconName: 'image',
        iconColor: '#000000',
        backgroundColor: '#FFAFAF',
        borderColor: '#F19C9C',
        title: 'Images',
        description: 'Create images on demand. From product shots to social graphics to full illustrations. Adjusts style, lighting, colors, and layout, or refines existing visuals with quick edits and touch-ups.',
        capabilities: [
            'Generate product shots',
            'Create social graphics',
            'Make illustrations',
            'Style & lighting variations',
            'Logo / asset creation',
            '+ Much more'
        ],
        image: '/images/landing-showcase/grow-not-linear.png',
        imageAlt: 'Growth Isn\'t Linear graphic example',
        fileType: 'image'
    },
    {
        id: 'slides',
        iconName: 'presentation',
        iconColor: '#000000',
        backgroundColor: '#FFCD7E',
        borderColor: '#E0B46F',
        title: 'Slides',
        description: 'Create stunning presentations instantly. From pitch decks to reports to training materials. Adjusts themes, layouts, content structure, or refines existing decks with quick edits and updates.',
        capabilities: [
            'Pitch decks',
            'Training material',
            'Report presentations',
            'Theme & layout variations',
            'Content restructuring',
            '+ Much more'
        ],
        image: '/images/landing-showcase/nexus.png',
        imageAlt: 'Nexus Enterprise Automation Platform slide example',
        fileType: 'pptx'
    },
    {
        id: 'data',
        iconName: 'bar-chart-3',
        iconColor: '#000000',
        backgroundColor: '#9DC2FF',
        borderColor: '#91B6F3',
        title: 'Data',
        description: 'Transforms raw data into insights. From spreadsheets to dashboards to visualizations. Cleans datasets, creates charts, builds reports, or refines existing analyses with quick updates.',
        capabilities: [
            'Dashboards',
            'Visualizations',
            'Data reports',
            'Clean & organize data',
            'Generate insights',
            '+ Much more'
        ],
        image: '/images/landing-showcase/table-overview.png',
        imageAlt: 'Financial Model Dashboard example',
        fileType: 'pptx'
    },
    {
        id: 'docs',
        iconName: 'file-text',
        iconColor: '#000000',
        backgroundColor: '#82DD95',
        borderColor: '#72C283',
        title: 'Docs',
        description: 'Writes and edits documents effortlessly. From proposals to guides to content pieces. Adjusts tone, structure, formatting, or refines existing documents with quick rewrites and polish.',
        capabilities: [
            'Proposals',
            'Guides & manuals',
            'Content pieces',
            'Tone & style variations',
            'Format & restructure',
            '+ Much more'
        ],
        image: '/images/landing-showcase/q3_2025.png',
        imageAlt: 'Q3 2025 Executive Summary Report example',
        fileType: 'pptx'
    },
    {
        id: 'research',
        iconName: 'search',
        iconColor: '#000000',
        backgroundColor: '#FFB5E4',
        borderColor: '#EF9FD1',
        title: 'Research',
        description: 'Researcher topics comprehensively. From market trends to competitive analysis to deep dives. Gather sources, synthesize findings, or refines existing research with quick updates.',
        capabilities: [
            'Analyze market trends',
            'Competitive research',
            'Deep topic dives',
            'Gather sources',
            'Synthesize findings',
            '+ Much more'
        ],
        image: '/images/landing-showcase/table-overview.png',
        imageAlt: 'Detailed Competitor Profiles research example',
        fileType: 'pptx'
    }
];

export function ShowCaseSection() {
    const [activeWorker, setActiveWorker] = useState<string>(workers[0].id);
    const isMobile = useIsMobile();

    const currentWorker = workers.find(w => w.id === activeWorker) || workers[0];

    return (
        <section className="w-full px-6 py-16 md:py-24 lg:py-32">
            <div className="max-w-7xl mx-auto">
                {/* Header */}
                <div className="text-center mb-12 md:mb-16">
                    <h2 className="text-[43px] font-medium leading-tight mb-4">
                        Different Workers for different jobs.
                    </h2>
                    <GrainText className="text-base md:text-lg max-w-3xl mx-auto block text-muted-foreground">
                        Kortix has specialized Workers depending on the work you need to get done.
                        <br />
                        Each Worker is built for a specific type of task, so you always get the right approach.
                    </GrainText>
                </div>

                {/* Workers Grid */}
                <div className="space-y-6">
                    {workers.map((worker) => (
                        <Card
                            key={worker.id}
                            className="transition-all duration-300 cursor-pointer !rounded-[24px] !p-6"
                            onMouseEnter={() => !isMobile && setActiveWorker(worker.id)}
                            onClick={() => isMobile && setActiveWorker(worker.id)}
                        >
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
                                {/* Left side - Info */}
                                <div className="flex flex-col">
                                    <div className="space-y-4 flex-1">
                                        {/* Icon */}
                                        <GrainIcon
                                            iconName={worker.iconName}
                                            backgroundColor={worker.backgroundColor}
                                            borderColor={worker.borderColor}
                                        />

                                        {/* Title */}
                                        <h3 className="text-[32px] font-semibold leading-tight">
                                            {worker.title}
                                        </h3>

                                        {/* Description */}
                                        <GrainText className="text-sm md:text-base leading-relaxed text-muted-foreground">
                                            {worker.description}
                                        </GrainText>

                                        {/* Capabilities */}
                                        <div className="flex flex-wrap gap-2">
                                            {worker.capabilities.map((capability, idx) => (
                                                <Badge
                                                    key={idx}
                                                    variant="outline"
                                                    className="text-sm h-9 px-4"
                                                >
                                                    {capability}
                                                </Badge>
                                            ))}
                                        </div>
                                    </div>

                                    {/* CTA Button - Always at bottom */}
                                    <Link href="/auth">
                                        <Button
                                            variant="default"
                                            size="default"
                                            className="w-fit flex items-center justify-center gap-2 bg-primary text-primary-foreground mt-4"
                                        >
                                            Try it out
                                            <span>→</span>
                                        </Button>
                                    </Link>
                                </div>

                                {/* Right side - Computer Preview */}
                                <div className="relative">
                                    <Card className="overflow-hidden transition-all duration-300 !p-0 h-full !rounded-[24px] flex flex-col !border-0 !gap-0">
                                        {/* Computer header */}
                                        <div className="bg-black text-white px-4 flex items-center justify-between flex-shrink-0 h-[65px]">
                                            <div className="flex items-center gap-2">
                                                <KortixLogo size={16} className="invert" />
                                                <span className="text-xl font-medium">
                                                    Kortix Computer
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                                                <span className="text-xs text-green-500 font-medium">Running</span>
                                            </div>
                                        </div>

                                        {/* Preview Image */}
                                        <div className="relative flex-1 bg-black overflow-hidden min-h-0 aspect-[539/271]">
                                            <Image
                                                src={worker.image}
                                                alt={worker.imageAlt}
                                                fill
                                                className="object-cover"
                                                priority={worker.id === workers[0].id}
                                            />
                                        </div>

                                        {/* Footer with file type */}
                                        <div className="bg-black text-white px-4 flex items-center flex-shrink-0 h-[71px]">
                                            <Badge variant="outline" className="text-xs font-mono gap-1.5 border-white/20 text-white">
                                                <svg
                                                    className="w-3 h-3"
                                                    viewBox="0 0 16 16"
                                                    fill="currentColor"
                                                >
                                                    <path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6L9 1zM8.5 2v4H13v7H3V2h5.5z" />
                                                </svg>
                                                {worker.fileType}
                                            </Badge>
                                        </div>
                                    </Card>
                                </div>
                            </div>
                        </Card>
                    ))}
                </div>
            </div>
        </section>
    );
}
