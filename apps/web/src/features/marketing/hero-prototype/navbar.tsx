'use client';

import { Navbar } from '@/components/home/navbar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { Button } from '@/components/ui/marketing/button';
import { ArrowDownIcon, ListIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { HeroActions } from './actions';
import './prototype.css';

const groups = [
  {
    label: 'Products',
    links: [
      { label: 'Web workspace', href: '/?variant=hero-a#web' },
      { label: 'CLI', href: '/?variant=hero-a#cli' },
      { label: 'Slack, Teams & Email', href: '/channels' },
      { label: 'Mobile', href: '/?variant=hero-a#mobile' },
      { label: 'API & SDK', href: '/docs/sdk' },
    ],
  },
  {
    label: 'Resources',
    links: [
      { label: 'Documentation', href: '/docs' },
      { label: 'Developers', href: '/developers' },
      { label: 'GitHub', href: 'https://github.com/kortix-ai/suna' },
    ],
  },
];

export default function PrototypeNavbar() {
  const pathname = usePathname();
  const params = useSearchParams();
  if (pathname !== '/' || params.get('variant') !== 'hero-a') return <Navbar isAbsolute />;
  return (
    <header className="rightfit-navbar bg-background text-foreground border-b">
      <nav aria-label="Main navigation" className="rightfit-container rightfit-nav-row">
        <Link
          href="/?variant=hero-a"
          aria-label="Kortix home"
          className="focus-visible:outline-ring w-fit rounded-sm focus-visible:outline-2"
        >
          <KortixLogo size={24} variant="icon" />
        </Link>
        <div className="hidden items-center gap-6 md:flex">
          {groups.map(({ label, links }) => (
            <DropdownMenu key={label}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-1.5 px-0 text-sm">
                  {label}
                  <ArrowDownIcon className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                {links.map((link) => (
                  <DropdownMenuItem key={link.href} asChild>
                    <Link href={link.href}>{link.label}</Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ))}
          <Link
            href="/blog"
            className="text-muted-foreground hover:text-foreground focus-visible:outline-ring rounded-sm text-sm focus-visible:outline-2"
          >
            Blog
          </Link>
        </div>
        <div className="flex items-center justify-end gap-3">
          <HeroActions compact />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="size-12 p-0 md:hidden"
                aria-label="Open navigation"
              >
                <ListIcon className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {groups
                .flatMap(({ links }) => links)
                .map((link) => (
                  <DropdownMenuItem key={link.href} asChild>
                    <Link href={link.href}>{link.label}</Link>
                  </DropdownMenuItem>
                ))}
              <DropdownMenuItem asChild>
                <Link href="/blog">Blog</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </nav>
    </header>
  );
}
