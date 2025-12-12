'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
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

const workerConfigs = [
    {
        id: 'slides',
        iconName: 'presentation',
        iconColor: '#000000',
        backgroundColor: '#FFCD7E',
        borderColor: '#E0B46F',
        image: '/images/landing-showcase/slides.png',
        fileTypeKey: 'pptx'
    },
    {
        id: 'data',
        iconName: 'bar-chart-3',
        iconColor: '#000000',
        backgroundColor: '#9DC2FF',
        borderColor: '#91B6F3',
        image: '/images/landing-showcase/data.png',
        fileTypeKey: 'preview'
    },
    {
        id: 'docs',
        iconName: 'file-text',
        iconColor: '#000000',
        backgroundColor: '#82DD95',
        borderColor: '#72C283',
        image: '/images/landing-showcase/docs.png',
        fileTypeKey: 'document'
    },
    {
        id: 'research',
        iconName: 'search',
        iconColor: '#000000',
        backgroundColor: '#FFB5E4',
        borderColor: '#EF9FD1',
        image: '/images/landing-showcase/research.png',
        fileTypeKey: 'document'
    },
    {
        id: 'images',
        iconName: 'image',
        iconColor: '#000000',
        backgroundColor: '#FFAFAF',
        borderColor: '#F19C9C',
        image: '/images/landing-showcase/images.png',
        fileTypeKey: 'image'
    }
];

export function ShowCaseSection() {
    const t = useTranslations('showcase');
    const [activeWorker, setActiveWorker] = useState<string>(workerConfigs[0].id);
    const isMobile = useIsMobile();

    const workers: WorkerType[] = workerConfigs.map((config) => ({
        ...config,
        title: t(`workers.${config.id}.title`),
        description: t(`workers.${config.id}.description`),
        capabilities: [
            t(`workers.${config.id}.capabilities.0`),
            t(`workers.${config.id}.capabilities.1`),
            t(`workers.${config.id}.capabilities.2`),
            t(`workers.${config.id}.capabilities.3`),
            t(`workers.${config.id}.capabilities.4`),
            t(`workers.${config.id}.capabilities.5`)
        ],
        imageAlt: t(`workers.${config.id}.imageAlt`),
        fileType: t(`workers.${config.id}.fileType`)
    }));

    const currentWorker = workers.find(w => w.id === activeWorker) || workers[0];

    return (
        <section className="w-full px-4 sm:px-6 py-12 sm:py-16 md:py-24 lg:py-32">
            <div className="max-w-7xl mx-auto">
                {/* Header */}
                <div className="text-center mb-8 sm:mb-12 md:mb-16">
                    <h1 className="text-2xl sm:text-3xl md:text-3xl lg:text-4xl font-medium tracking-tighter text-balance text-center mb-3 sm:mb-4">
                        {t('title')}
                    </h1>
                    <h2 className="text-[15px] max-w-3xl mx-auto block text-muted-foreground font-normal px-2">
                        {t('subtitle')}
                    </h2>
                </div>

                {/* Workers Grid */}
                <div className="space-y-4 sm:space-y-6">
                    {workers.map((worker) => (
                        <Card
                            key={worker.id}
                            className="transition-all duration-300 cursor-pointer !rounded-[20px] sm:!rounded-[24px] !p-4 sm:!p-6"
                            onMouseEnter={() => !isMobile && setActiveWorker(worker.id)}
                            onClick={() => isMobile && setActiveWorker(worker.id)}
                        >
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 lg:gap-8">
                                {/* Left side - Info */}
                                <div className="flex flex-col">
                                    <div className="space-y-3 sm:space-y-4 flex-1">
                                        {/* Icon */}
                                        <GrainIcon
                                            iconName={worker.iconName}
                                            backgroundColor={worker.backgroundColor}
                                            borderColor={worker.borderColor}
                                        />

                                        {/* Title */}
                                        <h3 className="text-2xl sm:text-3xl md:text-3xl lg:text-4xl font-medium tracking-tighter text-balance">
                                            {worker.title}
                                        </h3>

                                        {/* Description */}
                                        <GrainText className="text-sm leading-relaxed text-muted-foreground">
                                            {worker.description}
                                        </GrainText>

                                        {/* Capabilities */}
                                        <div className="flex flex-wrap gap-1.5 sm:gap-2">
                                            {worker.capabilities.map((capability, idx) => (
                                                <Badge
                                                    key={idx}
                                                    variant="outline"
                                                    className="text-xs sm:text-sm h-7 sm:h-9 px-2.5 sm:px-4"
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
                                            className="w-fit flex items-center justify-center gap-2 bg-primary text-primary-foreground mt-4 h-9 sm:h-10 text-sm"
                                        >
                                            {t('tryItOut')}
                                            <span>→</span>
                                        </Button>
                                    </Link>
                                </div>

                                {/* Right side - Computer Preview */}
                                <div className="relative">
                                    <Card className="overflow-hidden transition-all duration-300 !p-0 h-full !rounded-[16px] sm:!rounded-[24px] flex flex-col !border-0 !gap-0">
                                        {/* Computer header */}
                                        <div className="bg-background text-foreground px-3 sm:px-4 flex items-center justify-between flex-shrink-0 h-[50px] sm:h-[65px]">
                                            <div className="flex items-center gap-2">
                                                <KortixLogo size={14} className="sm:hidden opacity-50" />
                                                <KortixLogo size={14} className="hidden sm:block opacity-50" />
                                                <span className="text-base sm:text-xl font-medium">
                                                    {t('kortixComputer')}
                                                </span>
                                            </div>
                                            <Badge variant="outline" className="flex items-center gap-1.5 px-2 py-0.5 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400">
                                                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                                                <span className="text-[10px] sm:text-xs font-medium">{t('running')}</span>
                                            </Badge>
                                        </div>

                                        {/* Preview Image */}
                                        <div className="relative flex-1 bg-black overflow-hidden min-h-0 aspect-[539/271]">
                                            <Image
                                                src={worker.image}
                                                alt={worker.imageAlt}
                                                fill
                                                className="object-cover"
                                                quality={100}
                                                priority={worker.id === workers[0].id}
                                                sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
                                                unoptimized={true}
                                            />
                                        </div>

                                        {/* Footer with file type */}
                                        <div className="bg-background text-foreground px-3 sm:px-4 flex items-center flex-shrink-0 h-[50px] sm:h-[71px]">
                                            <Badge variant="outline" className="text-[10px] sm:text-xs font-mono gap-1 sm:gap-1.5">
                                                <svg
                                                    className="w-2.5 h-2.5 sm:w-3 sm:h-3"
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
