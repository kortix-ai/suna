'use client';

import Link from 'next/link';
import { Globe, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

export default function CountryError() {
  return (
    <div className="w-full relative overflow-hidden min-h-screen">
      <div className="relative flex flex-col items-center w-full px-4 sm:px-6 min-h-screen justify-center">
        {/* Animated background */}
        <AnimatedBg variant="hero" />

        <div className="relative z-10 w-full max-w-[456px] flex flex-col items-center gap-8">
          {/* Logo */}
          <KortixLogo size={32} />

          {/* Title */}
          <h1 className="text-[43px] font-normal tracking-tight text-foreground leading-none text-center whitespace-nowrap">
            Not available in your country
          </h1>

          {/* Description */}
          <p className="text-[16px] text-foreground/60 text-center leading-relaxed">
            We're sorry, Kortix is currently unavailable in your country. We're
            working to expand our availability and hope to serve you soon.
          </p>

          {/* Status Card */}
          <Card className="w-full h-24 bg-card border border-border">
            <CardContent className="p-6 flex items-center justify-between h-full">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10">
                  <Globe className="h-6 w-6 text-blue-500" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[14px] font-medium text-foreground">
                    Region restricted
                  </span>
                  <span className="text-[13px] text-foreground/60">
                    Service not available in your location
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Action Buttons */}
          <div className="w-full flex flex-col gap-3">
            <Button
              asChild
              size="lg"
              variant="outline"
              className="w-full h-12 rounded-lg font-medium"
            >
              <Link
                href="mailto:support@kortix.ai"
                className="flex items-center justify-center gap-2"
              >
                <Mail className="h-4 w-4" />
                <span>Contact Support</span>
              </Link>
            </Button>
          </div>

          {/* Footer text */}
          <p className="text-[13px] text-foreground/40 text-center">
            If you believe this is an error, please reach out to our support
            team.
          </p>
        </div>
      </div>
    </div>
  );
}
