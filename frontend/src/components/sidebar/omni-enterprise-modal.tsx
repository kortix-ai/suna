'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMediaQuery } from '@/hooks/use-media-query';
import Image from 'next/image';
import Cal, { getCalApi } from '@calcom/embed-react';
import { useTheme } from 'next-themes';

export function OmniProcessModal() {
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const { resolvedTheme } = useTheme();
  const isDarkMode = resolvedTheme === 'dark';

  useEffect(() => {
    (async function () {
      const cal = await getCalApi({ namespace: 'enterprise-demo' });
      cal('ui', { hideEventTypeDetails: true, layout: 'month_view' });
    })();
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex items-center gap-3">
          <span>Schedule Demo</span>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="text-primary-foreground dark:text-black group-hover:translate-x-1 transition-transform duration-200"
          >
            <path
              d="M7 17L17 7M17 7H8M17 7V16"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </DialogTrigger>
      <DialogContent className="p-0 gap-0 border-none max-w-[70vw] rounded-xl overflow-hidden">
        <DialogTitle className="sr-only">
          Custom AI Employees for your Business.
        </DialogTitle>
        <div className="grid grid-cols-1 md:grid-cols-2 h-[800px]">
          {/* Info Panel */}
          <div className="p-8 flex flex-col bg-white dark:bg-black relative h-full overflow-y-auto border-r border-gray-200 dark:border-gray-800">
            <div className="relative z-10 flex flex-col h-full">
              <div className="mb-8 mt-0 flex-shrink-0">
                <Image
                  src={isDarkMode ? '/OMNI-Logo-Dark.png' : '/OMNI-Logo-light.png'}
                  alt="OMNI Logo"
                  width={60}
                  height={21}
                  className="h-6 w-auto object-contain"
                />
              </div>

              <h2 className="text-2xl md:text-3xl font-semibold tracking-tight mb-4 text-foreground flex-shrink-0">
                Custom AI Employees for your Business
              </h2>
              <p className="text-base md:text-lg text-muted-foreground mb-8 max-w-lg flex-shrink-0">
                Create custom AI employees for your business based on your human
                employees data.
              </p>

              <div className="space-y-8 mb-auto flex-shrink-0">
                <div className="transition-all duration-300 hover:translate-x-1 group">
                  <h3 className="text-base md:text-lg font-medium mb-3 flex items-center">
                    <span className="bg-primary text-primary-foreground w-7 h-7 rounded-full inline-flex items-center justify-center mr-3 text-sm group-hover:shadow-md transition-all duration-300">
                      1
                    </span>
                    <span>Record</span>
                  </h3>
                  <p className="text-base text-muted-foreground ml-10">
                    We record what employees do to understand their workflows
                    and tasks.
                  </p>
                </div>

                <div className="transition-all duration-300 hover:translate-x-1 group">
                  <h3 className="text-base md:text-lg font-medium mb-3 flex items-center">
                    <span className="bg-primary text-primary-foreground w-7 h-7 rounded-full inline-flex items-center justify-center mr-3 text-sm group-hover:shadow-md transition-all duration-300">
                      2
                    </span>
                    <span>Train</span>
                  </h3>
                  <p className="text-base text-muted-foreground ml-10">
                    AI is trained on the captured data to learn the tasks and
                    decision-making.
                  </p>
                </div>

                <div className="transition-all duration-300 hover:translate-x-1 group">
                  <h3 className="text-base md:text-lg font-medium mb-3 flex items-center">
                    <span className="bg-primary text-primary-foreground w-7 h-7 rounded-full inline-flex items-center justify-center mr-3 text-sm group-hover:shadow-md transition-all duration-300">
                      3
                    </span>
                    <span>Automate</span>
                  </h3>
                  <p className="text-base text-muted-foreground ml-10">
                    AI agents automate tasks previously done by humans, with
                    continuous learning and improvement.
                  </p>
                </div>
              </div>

              <div className="border-t border-gray-200 dark:border-gray-800 pt-6 mt-6 flex-shrink-0">
                <p className="text-base font-medium mb-3">Key Benefits</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-y-2 gap-x-4">
                  <div className="flex items-center">
                    <div className="w-2 h-2 rounded-full bg-primary mr-2"></div>
                    <p className="text-sm text-muted-foreground">
                      Reduce operational costs
                    </p>
                  </div>
                  <div className="flex items-center">
                    <div className="w-2 h-2 rounded-full bg-primary mr-2"></div>
                    <p className="text-sm text-muted-foreground">
                      Increase workflow efficiency
                    </p>
                  </div>
                  <div className="flex items-center">
                    <div className="w-2 h-2 rounded-full bg-primary mr-2"></div>
                    <p className="text-sm text-muted-foreground">
                      Improve task accuracy
                    </p>
                  </div>
                  <div className="flex items-center">
                    <div className="w-2 h-2 rounded-full bg-primary mr-2"></div>
                    <p className="text-sm text-muted-foreground">
                      Scale operations seamlessly
                    </p>
                  </div>
                  <div className="flex items-center">
                    <div className="w-2 h-2 rounded-full bg-primary mr-2"></div>
                    <p className="text-sm text-muted-foreground">
                      24/7 productivity
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="bg-white dark:bg-[#171717] h-full overflow-hidden">
            <div className="h-full overflow-auto">
              <Cal
                namespace="enterprise-demo"
                calLink="team/omniscience-labs/omni-intro-chat"
                style={{ width: '100%', height: '100%' }}
                config={{
                  layout: 'month_view',
                  hideEventTypeDetails: 'false',
                }}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
