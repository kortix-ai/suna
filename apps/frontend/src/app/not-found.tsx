'use client';

import Link from 'next/link';
import { ArrowLeft, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

export default function NotFound() {
  return (
    <div className="w-full relative overflow-hidden min-h-[100dvh]">
      <div className="relative flex flex-col items-center w-full px-3 sm:px-6 min-h-[100dvh] justify-center py-8">
        {/* Animated background - exactly like maintenance page */}
        <AnimatedBg variant="hero" />

        <div className="relative z-10 w-full max-w-[456px] flex flex-col items-center gap-5 sm:gap-8">
          {/* Logo - 32px height */}
          <KortixLogo size={28} className="sm:w-8 sm:h-8" />

          {/* Title - responsive */}
          <h1 className="text-3xl sm:text-[43px] font-normal tracking-tight text-foreground leading-tight text-center">
            Page not found
          </h1>

          {/* Description - responsive */}
          <p className="text-sm sm:text-[16px] text-foreground/60 text-center leading-relaxed px-2">
            The page you're looking for doesn't exist or has been moved.
          </p>

          {/* Status Card - 456px width, 96px height */}
          <Card className="w-full h-24 bg-card border border-border">
            <CardContent className="p-6 flex items-center justify-between h-full">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-500/10">
                  <AlertCircle className="h-6 w-6 text-orange-500" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[14px] font-medium text-foreground">
                    404 Error
                  </span>
                  <span className="text-[13px] text-foreground/60">
                    Resource not available
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Action Button */}
          <Button
            asChild
            size="lg"
            className="w-full h-12 rounded-lg font-medium"
          >
            <Link href="/" className="flex items-center justify-center gap-2">
              <ArrowLeft className="h-4 w-4" />
              <span>Return Home</span>
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
