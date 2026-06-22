import { Button } from '@/components/ui/button';
import Link from 'next/link';
import React from 'react';

type Props = {
  title: string;
  description: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  docs?: string;
};

const CustomizeSectionWrapper = ({ title, description, children, action, docs }: Props) => {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-20">
          <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <h2 className="text-foreground text-xl font-medium">{title}</h2>
              <span className="flex items-center gap-1">
                <p className="text-muted-foreground text-sm">{description}</p>
                {docs && (
                  <Button variant="transparent" className="m-0 p-0" asChild>
                    <Link href={docs} target="_blank" rel="noopener noreferrer">Learn more.</Link>
                  </Button>
                )}
              </span>
            </div>
            {action ? <div className="mt-2 shrink-0 sm:mt-0">{action}</div> : null}
          </header>

          {children}
        </div>
      </div>
    </div>
  );
};

export default CustomizeSectionWrapper;
