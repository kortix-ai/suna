'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { Icon } from '../icon/icon';

type CompareOption = { slug: string; name: string };

/**
 * Inline competitor switcher for the compare hero — renders the competitor name
 * as a dropdown so visitors can jump straight to another "Kortix vs X" page.
 * Lives inside the <h1>; text size/weight are inherited from the heading.
 */
export function CompareSwitcher({
  current,
  options,
}: {
  current: CompareOption;
  options: CompareOption[];
}) {
  const compareIcon = (slug: string) => {
    switch (slug) {
      case 'zapier':
        return <Icon.Zapier />;
      case 'openclaw':
        return <Icon.OpenClaw />;
      case 'viktor':
        return <Icon.Viktor />;
      case 'chatgpt':
        return <Icon.ChatGPT />;
      case 'claude':
        return <Icon.Claude />;
      default:
        return null;
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Comparing Kortix with ${current.name}. Change competitor`}
          className="group inline-flex items-center gap-2 px-3 py-1 transition-colors outline-none focus-within:ring-0 focus-within:outline-none focus:outline-none focus-visible:ring-0 focus-visible:outline-none sm:gap-3 sm:px-4 sm:py-1.5"
        >
          <span className="text-foreground">{current.name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-1.5 bg-sidebar/10 backdrop-blur-xl">
        {options.map((opt) => {
          const active = opt.slug === current.slug;
          return (
            <DropdownMenuItem key={opt.slug} asChild className="px-4 py-3.5">
              <Link
                href={`/compare/${opt.slug}`}
                className={cn(
                  'flex items-center justify-between gap-3 text-lg font-medium',
                  active && 'text-foreground',
                )}
              >
                <span className="[&_svg]:size-6">{compareIcon(opt.slug)}</span>
                {opt.name}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
