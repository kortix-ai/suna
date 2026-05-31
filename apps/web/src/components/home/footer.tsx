'use client';

import { Icon } from '@/features/icon/icon';
import Link from 'next/link';
import { Button } from '../ui/marketing/button';
import { ThemeToggle } from './theme-toggle';

const Footer = () => {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-border w-full border-t">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span>&copy; {currentYear} Kortix</span>
            <div className="*:text-muted-foreground *:hover:text-foreground flex items-center gap-x-4 *:transition-colors *:hover:no-underline">
              <Button variant="link" asChild size="xs">
                <Link href="/support">Support</Link>
              </Button>
              <Button variant="link" asChild size="xs">
                <Link href="/legal?tab=privacy">Privacy</Link>
              </Button>

              <Button variant="link" asChild size="xs">
                <Link href="/legal?tab=terms">Terms</Link>
              </Button>

              <Button variant="link" asChild size="xs">
                <Link href="https://status.kortix.com" target="_blank" rel="noopener noreferrer">
                  Status
                </Link>
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Link
                href="https://github.com/kortix-ai/suna"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
                className="text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded transition-colors [&>svg]:size-5"
              >
                <Icon.Github />
              </Link>
              <Link
                href="https://discord.com/invite/RvFhXUdZ9H"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Discord"
                className="text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded transition-colors [&>svg]:size-5"
              >
                <Icon.Discord />
              </Link>
              <Link
                href="https://x.com/kortix"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="X"
                className="text-muted-foreground hover:text-foreground flex size-5 items-center justify-center rounded transition-colors [&>svg]:size-5"
              >
                <Icon.Twitter />
              </Link>
            </div>
            <ThemeToggle variant="compact" />
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
