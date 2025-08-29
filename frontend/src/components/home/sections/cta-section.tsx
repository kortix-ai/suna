'use client';

import Image from 'next/image';
import { siteConfig } from '@/lib/home';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import Waves from '@/Backgrounds/Waves/Waves';

export function CTASection() {
  const { ctaSection } = siteConfig;
  const { resolvedTheme } = useTheme();

  // Use light mode colors for both themes
  const waveColors = {
    lineColor: '#888888',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  };

  return (
    <section
      id="cta"
      className="flex flex-col items-center justify-center w-full pt-12 pb-12"
    >
      <div className="w-full max-w-6xl mx-auto px-6">
        <div className="h-[400px] md:h-[400px] overflow-hidden shadow-xl w-full border border-border rounded-xl relative z-20 bg-gradient-to-br from-blue-600 to-blue-800">
          {/* Waves Background */}
          <div className="absolute inset-0">
            <Waves
              lineColor={waveColors.lineColor}
              backgroundColor={waveColors.backgroundColor}
              waveSpeedX={0.02}
              waveSpeedY={0.01}
              waveAmpX={40}
              waveAmpY={20}
              xGap={12}
              yGap={36}
              friction={0.9}
              tension={0.01}
              maxCursorMove={120}
            />
          </div>
          
          {/* Content overlay */}
          <div className="absolute inset-0 -top-32 md:-top-40 flex flex-col items-center justify-center z-10">
            <h1 className="text-white text-4xl md:text-7xl font-medium tracking-tighter max-w-xs md:max-w-xl text-center drop-shadow-lg">
              {ctaSection.title}
            </h1>
            <div className="absolute bottom-10 flex flex-col items-center justify-center gap-2">
              <Link
                href={ctaSection.button.href}
                className="bg-white text-black font-semibold text-sm h-10 w-fit px-4 rounded-full flex items-center justify-center shadow-md hover:bg-gray-100 transition-colors"
              >
                {ctaSection.button.text}
              </Link>
              <span className="text-white text-sm drop-shadow-md">{ctaSection.subtext}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
