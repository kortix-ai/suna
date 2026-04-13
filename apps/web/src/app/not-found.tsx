'use client';

import Link from 'next/link';
import { ArrowLeft, AlertCircle } from 'lucide-react';
import { motion } from 'framer-motion';
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

        {/* Noise/static overlay for consistency with error pages */}
        <div
          className="pointer-events-none absolute inset-0 z-0 opacity-[0.02] dark:opacity-[0.035]"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            backgroundRepeat: 'repeat',
            backgroundSize: '256px 256px',
          }}
        />

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="relative z-10 w-full max-w-[456px] flex flex-col items-center gap-5 sm:gap-8"
        >
          {/* Logo - 32px height */}
          <KortixLogo size={28} className="sm:w-8 sm:h-8" />

          {/* Animated 404 text */}
          <div className="relative select-none">
            <motion.div
              className="font-mono text-[72px] sm:text-[96px] font-bold leading-none tracking-tighter text-foreground/[0.06]"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.1, duration: 0.5 }}
            >
              404
            </motion.div>
            {/* Subtle glitch slice */}
            <motion.div
              className="absolute left-0.5 top-0 font-mono text-[72px] sm:text-[96px] font-bold leading-none tracking-tighter text-foreground/[0.04]"
              animate={{ opacity: [0, 0.5, 0, 0.3, 0] }}
              transition={{
                duration: 2.5,
                repeat: Infinity,
                repeatDelay: 7,
                times: [0, 0.02, 0.04, 0.06, 0.08],
              }}
              style={{ clipPath: 'inset(25% 0 45% 0)' }}
            >
              404
            </motion.div>
          </div>

          {/* Title - responsive */}
          <h1 className="text-3xl sm:text-[43px] font-normal tracking-tight text-foreground leading-tight text-center">
            Page not found
          </h1>

          {/* Description - responsive */}
          <p className="text-sm sm:text-base text-foreground/60 text-center leading-relaxed px-2">
            The page you&apos;re looking for doesn&apos;t exist or has been moved.
          </p>

          {/* Status Card - 456px width, 96px height */}
          <Card className="w-full h-24 bg-card border border-border">
            <CardContent className="p-6 flex items-center justify-between h-full">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-500/10">
                  <AlertCircle className="h-6 w-6 text-orange-500" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    404 Error
                  </span>
                  <span className="text-[13px] text-foreground/60 font-mono">
                    resource not available
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Action Button */}
          <Button
            asChild
            size="lg"
            className="w-full h-12"
          >
            <Link href="/instances" className="flex items-center justify-center gap-2">
              <ArrowLeft className="h-4 w-4" />
              <span>Return Home</span>
            </Link>
          </Button>
        </motion.div>
      </div>
    </div>
  );
}
