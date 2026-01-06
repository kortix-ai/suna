'use client';

import Image from 'next/image';

export function WordmarkFooter() {

    return (
        <section className="w-full animate-in fade-in-0 duration-700 fill-mode-both">
            <div className="max-w-7xl mx-auto px-6 pt-16 md:pt-24">
                {/* Wordmark */}
                <div className="relative w-full md:aspect-[1150/344] aspect-square">
                    <div className="absolute inset-0">
                        <div className="relative w-full h-full" style={{ isolation: 'isolate' }}>
                            {/* Mobile: Symbol */}
                            <div className="md:hidden absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: '280px', height: '280px' }}>
                                <Image
                                    src="/kortix-symbol.svg"
                                    alt="Kortix"
                                    fill
                                    className="object-contain invert dark:invert-0 opacity-15"
                                    priority
                                    style={{ mixBlendMode: 'normal' }}
                                />
                                {/* Grain texture overlay */}
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
                            {/* Desktop: Full wordmark */}
                            <Image
                                src="/wordmark.svg"
                                alt="Kortix"
                                fill
                                className="object-contain dark:invert hidden md:block"
                                priority
                                style={{ mixBlendMode: 'normal' }}
                            />
                            {/* Grain texture overlay for desktop */}
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
