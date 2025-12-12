'use client';

import { NavMenu } from '@/components/home/nav-menu';
import { ThemeToggle } from '@/components/home/theme-toggle';
import { LocaleSwitcher } from '@/components/home/locale-switcher';
import { siteConfig } from '@/lib/site-config';
import { cn } from '@/lib/utils';
import { Menu, X, Github } from 'lucide-react';
import { AnimatePresence, motion, useScroll } from 'framer-motion';
import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { useAuth } from '@/components/AuthProvider';
import { useGitHubStars } from '@/hooks/utils';
import { useRouter, usePathname } from 'next/navigation';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

const INITIAL_WIDTH = '70rem';
const MAX_WIDTH = '1000px';

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const drawerVariants = {
  hidden: { opacity: 0, y: 100 },
  visible: {
    opacity: 1,
    y: 0,
    rotate: 0,
    transition: {
      type: 'spring' as const,
      damping: 15,
      stiffness: 200,
      staggerChildren: 0.03,
    },
  },
  exit: {
    opacity: 0,
    y: 100,
    transition: { duration: 0.1 },
  },
};

const drawerMenuContainerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

const drawerMenuVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

interface NavbarProps {
  tabs?: string[];
}

export function Navbar({ tabs }: NavbarProps = {}) {
  const { scrollY } = useScroll();
  const [hasScrolled, setHasScrolled] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('hero');
  const { theme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const { user } = useAuth();
  const { formattedStars, loading: starsLoading } = useGitHubStars('kortix-ai', 'suna');
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('common');

  // Filter nav links based on tabs prop
  const filteredNavLinks = tabs
    ? siteConfig.nav.links.filter(link =>
      tabs.includes(link.name.toLowerCase())
    )
    : siteConfig.nav.links;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      const sections = filteredNavLinks.map((item) =>
        item.href.substring(1),
      );

      for (const section of sections) {
        const element = document.getElementById(section);
        if (element) {
          const rect = element.getBoundingClientRect();
          if (rect.top <= 150 && rect.bottom >= 150) {
            setActiveSection(section);
            break;
          }
        }
      }
    };

    window.addEventListener('scroll', handleScroll);
    handleScroll();

    return () => window.removeEventListener('scroll', handleScroll);
  }, [filteredNavLinks]);

  useEffect(() => {
    const unsubscribe = scrollY.on('change', (latest) => {
      setHasScrolled(latest > 10);
    });
    return unsubscribe;
  }, [scrollY]);

  const toggleDrawer = () => setIsDrawerOpen((prev) => !prev);
  const handleOverlayClick = () => setIsDrawerOpen(false);

  return (
    <header
      className={cn(
        'sticky z-50 flex justify-center transition-all duration-300',
        hasScrolled ? 'top-6 mx-4 md:mx-0' : 'top-4 mx-2 md:mx-0',
      )}
    >
      <motion.div
        initial={{ width: INITIAL_WIDTH }}
        animate={{ width: hasScrolled ? MAX_WIDTH : INITIAL_WIDTH }}
        transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
      >
        <div
          className={cn(
            'mx-auto max-w-7xl rounded-2xl transition-all duration-300 xl:px-0',
            hasScrolled
              ? 'px-2 md:px-2 border border-border backdrop-blur-lg bg-background/75'
              : 'shadow-none px-3 md:px-7',
          )}
        >
          <div className="flex h-[56px] items-center p-2 md:p-4">
            {/* Left Section - Logo */}
            <div className="flex items-center justify-start flex-shrink-0 w-auto md:w-[200px]">
              <Link href="/" className="flex items-center gap-3">
                <KortixLogo size={18} variant='logomark' />
              </Link>
            </div>
            {/* 
            <div className="hidden md:flex items-center justify-center flex-grow">
              <NavMenu links={filteredNavLinks} />
            </div> */}

            {/* Right Section - Actions */}
            <div className="flex items-center justify-end flex-shrink-0 w-auto md:w-[200px] ml-auto">
              <div className="flex flex-row items-center gap-2 md:gap-3 shrink-0">
                <div className="flex items-center space-x-3">
                  <LocaleSwitcher variant="compact" />
                  <Link
                    href="https://github.com/kortix-ai/suna"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-full bg-transparent text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent/30 transition-all duration-200"
                    aria-label="GitHub Repository"
                  >
                    <Github className="size-3.5" />
                    <span className={`text-xs font-medium transition-opacity duration-200 ${starsLoading ? 'opacity-50' : 'opacity-100'}`}>
                      {formattedStars}
                    </span>
                  </Link>
                  {user ? (
                    <Button
                      asChild
                      variant="default"
                      size="sm"
                      className="w-fit flex items-center justify-center gap-2 bg-primary text-primary-foreground shadow-[inset_0_1px_2px_rgba(255,255,255,0.25),0_3px_3px_-1.5px_rgba(16,24,40,0.06),0_1px_1px_rgba(16,24,40,0.08)] border border-white/[0.12]"
                    >
                      <Link href="/dashboard">
                        Dashboard
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      asChild
                      variant="default"
                      size="sm"
                      className="w-fit flex items-center justify-center gap-2 bg-primary text-primary-foreground shadow-[inset_0_1px_2px_rgba(255,255,255,0.25),0_3px_3px_-1.5px_rgba(16,24,40,0.06),0_1px_1px_rgba(16,24,40,0.08)] border border-white/[0.12]"
                    >
                      <Link href="/auth">
                        {t('tryFree')}
                      </Link>
                    </Button>
                  )}
                </div>
                {/* <ThemeToggle /> */}
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Mobile Drawer */}
      <AnimatePresence>
        {isDrawerOpen && (
          <>
            <motion.div
              className="fixed inset-0 bg-black/50 backdrop-blur-sm"
              initial="hidden"
              animate="visible"
              exit="exit"
              variants={overlayVariants}
              transition={{ duration: 0.2 }}
              onClick={handleOverlayClick}
            />

            <motion.div
              className="fixed inset-x-0 w-[95%] max-w-md mx-auto bottom-3 bg-background border border-border p-4 rounded-xl shadow-lg z-50"
              initial="hidden"
              animate="visible"
              exit="exit"
              variants={drawerVariants}
            >
              {/* Mobile menu content */}
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <Link href="/" className="flex items-center gap-3" onClick={() => setIsDrawerOpen(false)}>
                    <KortixLogo size={20} variant='logomark' />
                  </Link>
                  <button
                    onClick={toggleDrawer}
                    className="border border-border rounded-lg p-1.5 cursor-pointer hover:bg-accent transition-colors"
                    aria-label="Close menu"
                  >
                    <X className="size-4" />
                  </button>
                </div>

                <motion.ul
                  className="flex flex-col text-sm mb-4 border border-border rounded-md"
                  variants={drawerMenuContainerVariants}
                >
                  <AnimatePresence>
                    {filteredNavLinks.map((item) => (
                      <motion.li
                        key={item.id}
                        className="p-2.5 border-b border-border last:border-b-0"
                        variants={drawerMenuVariants}
                      >
                        <a
                          href={item.href}
                          onClick={(e) => {
                            // If it's an external link (not starting with #), let it navigate normally
                            if (!item.href.startsWith('#')) {
                              setIsDrawerOpen(false);
                              return;
                            }

                            e.preventDefault();

                            // If we're not on the homepage, redirect to homepage with the section
                            if (pathname !== '/') {
                              router.push(`/${item.href}`);
                              setIsDrawerOpen(false);
                              return;
                            }

                            const element = document.getElementById(
                              item.href.substring(1),
                            );
                            element?.scrollIntoView({ behavior: 'smooth' });
                            setIsDrawerOpen(false);
                          }}
                          className={`underline-offset-4 hover:text-primary/80 transition-colors ${(item.href.startsWith('#') && pathname === '/' && activeSection === item.href.substring(1)) || (item.href === pathname)
                            ? 'text-primary font-medium'
                            : 'text-primary/60'
                            }`}
                        >
                          {item.name}
                        </a>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </motion.ul>

                {/* Action buttons */}
                <div className="flex flex-col gap-3">
                  {user ? (
                    <Button
                      asChild
                      variant="default"
                      size="sm"
                      className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground shadow-[inset_0_1px_2px_rgba(255,255,255,0.25),0_3px_3px_-1.5px_rgba(16,24,40,0.06),0_1px_1px_rgba(16,24,40,0.08)] border border-white/[0.12]"
                    >
                      <Link href="/dashboard">
                        Dashboard
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      asChild
                      variant="default"
                      size="sm"
                      className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground shadow-[inset_0_1px_2px_rgba(255,255,255,0.25),0_3px_3px_-1.5px_rgba(16,24,40,0.06),0_1px_1px_rgba(16,24,40,0.08)] border border-white/[0.12]"
                    >
                      <Link href="/auth">
                        {t('tryFree')}
                      </Link>
                    </Button>
                  )}
                  
                  {/* GitHub Stars & Language Switcher Row */}
                  <div className="flex items-center gap-2">
                    {/* GitHub Stars Link */}
                    <Link
                      href="https://github.com/kortix-ai/suna"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 h-9 px-3 text-xs font-medium rounded-lg bg-accent/50 hover:bg-accent text-muted-foreground hover:text-foreground transition-all duration-200 flex-1 min-w-0"
                      aria-label="GitHub Repository"
                      onClick={() => setIsDrawerOpen(false)}
                    >
                      <Github className="size-4 shrink-0" />
                      <span className={`text-xs font-medium transition-opacity duration-200 truncate ${starsLoading ? 'opacity-50' : 'opacity-100'}`}>
                        {formattedStars}
                      </span>
                    </Link>
                    
                    {/* Language Switcher */}
                    <div className="flex-1 min-w-0">
                      <LocaleSwitcher variant="full" />
                    </div>
                    
                    {/* Theme Toggle */}
                    <div className="shrink-0">
                      <ThemeToggle />
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </header>
  );
}

