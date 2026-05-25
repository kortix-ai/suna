'use client';

/**
 * Product mega-menu — the navbar dropdown that maps the whole platform.
 *
 * Each item deep-links into the homepage InteractiveDemo via the URL hash
 * (e.g. `/#agents`), except Framework which routes to /technology. The same
 * PRODUCT_ITEMS list backs the desktop hover menu and the mobile drawer.
 */

import { useRef, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Bot, Sparkles, Blocks, Clock, Radio, Shield, Boxes, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ProductItem {
  title: string;
  desc: string;
  href: string;
  icon: LucideIcon;
}

export const PRODUCT_ITEMS: ProductItem[] = [
  { title: 'Agents', desc: 'A specialist agent for every role.', href: '/#agents', icon: Bot },
  { title: 'Skills', desc: 'Reusable know-how every agent shares.', href: '/#skills', icon: Sparkles },
  { title: 'Integrations', desc: '3,000+ tools, connected once.', href: '/#integrations', icon: Blocks },
  { title: 'Scheduling', desc: 'Work that runs on a schedule, 24/7.', href: '/#scheduling', icon: Clock },
  { title: 'Channels', desc: 'Slack, email, web & WhatsApp.', href: '/#channels', icon: Radio },
  { title: 'Security', desc: 'Roles, scoping, secrets & audit.', href: '/#security', icon: Shield },
  { title: 'Framework', desc: 'The open framework it’s all built on.', href: '/technology', icon: Boxes },
];

export function ProductMegaMenu() {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openNow = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const closeSoon = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <div className="relative" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <button
        className={cn(
          'flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
          open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        Product
        <ChevronDown className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="absolute left-1/2 top-full z-50 -translate-x-1/2 pt-3"
          >
            <div className="w-[34rem] rounded-2xl border border-border bg-background/95 p-2 shadow-xl backdrop-blur-xl">
              <div className="grid grid-cols-2 gap-1">
                {PRODUCT_ITEMS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.title}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className="group flex items-start gap-3 rounded-lg p-3 transition-colors hover:bg-muted/60"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground transition-colors group-hover:text-foreground">
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-foreground">{item.title}</span>
                        <span className="block text-xs leading-snug text-muted-foreground">{item.desc}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
