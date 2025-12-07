'use client';

import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Search, ArrowUp } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/home/theme-toggle';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';

// Floating star component
function Star({ delay, size, x, y }: { delay: number; size: number; x: number; y: number }) {
  return (
    <motion.div
      className="absolute rounded-full bg-foreground/40"
      style={{
        width: size,
        height: size,
        left: `${x}%`,
        top: `${y}%`,
      }}
      initial={{ opacity: 0, scale: 0 }}
      animate={{
        opacity: [0, 0.8, 0],
        scale: [0, 1, 0],
      }}
      transition={{
        duration: 4,
        delay,
        repeat: Infinity,
        ease: 'easeInOut',
      }}
    />
  );
}

// Decorative plus sign
function DecorativePlus({ x, y, size = 12 }: { x: number; y: number; size?: number }) {
  return (
    <motion.div
      className="absolute text-foreground/15 font-light select-none pointer-events-none"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        fontSize: size,
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1, delay: Math.random() * 2 }}
    >
      +
    </motion.div>
  );
}

// Activity card type for card stack
interface ActivityCard {
  id: number;
  name: string;
  designation: string;
  content: React.ReactNode;
}

// Custom Card Stack styled for Kortix
function ActivityCardStack({ items }: { items: ActivityCard[] }) {
  const [cards, setCards] = useState<ActivityCard[]>(items);
  const CARD_OFFSET = 8;
  const SCALE_FACTOR = 0.04;

  useEffect(() => {
    const interval = setInterval(() => {
      setCards((prevCards) => {
        const newArray = [...prevCards];
        newArray.unshift(newArray.pop()!);
        return newArray;
      });
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative h-[80px] w-full">
      {cards.map((card, index) => (
        <motion.div
          key={card.id}
          className="absolute inset-x-0 px-4 py-3 rounded-2xl border bg-card cursor-pointer"
          style={{ transformOrigin: 'top center' }}
          animate={{
            top: index * -CARD_OFFSET,
            scale: 1 - index * SCALE_FACTOR,
            zIndex: cards.length - index,
          }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-foreground font-medium text-sm">{card.name}</p>
              <p className="text-muted-foreground text-xs">{card.content}</p>
            </div>
            <span className="text-muted-foreground/70 text-[10px] whitespace-nowrap flex-shrink-0">
              {card.designation}
            </span>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

export default function ExplorerPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [articleCount, setArticleCount] = useState(1089057);
  const { user, isLoading } = useAuth();
  const router = useRouter();

  // Generate star positions only once on mount (client-side)
  const stars = useMemo(() => {
    if (typeof window === 'undefined') return [];
    return Array.from({ length: 50 }, (_, i) => ({
      id: i,
      delay: Math.random() * 5,
      size: Math.random() * 2 + 1,
      x: Math.random() * 100,
      y: Math.random() * 100,
    }));
  }, []);

  // Generate plus positions only once on mount (client-side)
  const plusSigns = useMemo(() => {
    if (typeof window === 'undefined') return [];
    return [
      { x: 5, y: 18 },
      { x: 26, y: 52 },
      { x: 88, y: 8 },
      { x: 92, y: 55 },
      { x: 15, y: 78 },
      { x: 78, y: 32 },
      { x: 45, y: 12 },
      { x: 58, y: 78 },
    ];
  }, []);

  // Activity cards for the card stack
  const activityCards: ActivityCard[] = [
    {
      id: 0,
      name: 'Santhome',
      designation: '48 minutes ago',
      content: 'New edit approved by Kortix',
    },
    {
      id: 1,
      name: 'Transformer Architecture',
      designation: '2 hours ago',
      content: 'Article updated with new citations',
    },
    {
      id: 2,
      name: 'Neural Networks',
      designation: '5 hours ago',
      content: 'New section added by contributor',
    },
  ];

  useEffect(() => {
    setMounted(true);

    // Animate article count slowly
    const interval = setInterval(() => {
      setArticleCount((prev) => prev + Math.floor(Math.random() * 3));
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  const handleSearch = () => {
    if (searchQuery.trim()) {
      console.log('Searching for:', searchQuery);
      // Navigate to the result page with the search query as URL slug
      const slug = searchQuery.trim().toLowerCase().replace(/\s+/g, '-');
      router.push(`/explorer/${encodeURIComponent(slug)}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    clearUserLocalStorage();
    router.push('/auth');
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((part) => part.charAt(0))
      .join('')
      .toUpperCase()
      .substring(0, 2);
  };

  if (!mounted) {
    return <div className="min-h-screen w-full bg-background" />;
  }

  return (
    <div className="relative h-screen w-full overflow-hidden bg-background flex flex-col">
      {/* Cosmic gradient background */}
      <div className="absolute inset-0 pointer-events-none">
        {/* Subtle gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-b from-muted/30 via-transparent to-transparent dark:from-primary/5" />

        {/* Subtle corner glows */}
        <div className="absolute top-0 left-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-[150px] -translate-x-1/2 -translate-y-1/2" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] bg-primary/5 rounded-full blur-[120px] translate-x-1/3 translate-y-1/3" />

        {/* Vignette effect */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,var(--background)_70%)] opacity-40" />
      </div>

      {/* Floating stars */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {stars.map((star) => (
          <Star key={star.id} delay={star.delay} size={star.size} x={star.x} y={star.y} />
        ))}
      </div>

      {/* Decorative plus signs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {plusSigns.map((plus, i) => (
          <DecorativePlus key={i} x={plus.x} y={plus.y} size={14} />
        ))}
      </div>

      {/* Header */}
      <header className="relative z-10 flex items-center justify-between p-4 md:p-6 flex-shrink-0">
        <Link href="/" className="flex items-center gap-3">
          <KortixLogo size={18} variant="logomark" />
        </Link>

        <div className="flex items-center gap-3">
          <ThemeToggle />

          {/* Profile Dropdown */}
          {user && !isLoading ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="relative h-9 w-9 rounded-full p-0 border border-border hover:bg-accent"
                >
                  <Avatar className="h-9 w-9">
                    <AvatarImage
                      src={user.user_metadata?.avatar_url}
                      alt={user.user_metadata?.full_name || user.email || 'User'}
                    />
                    <AvatarFallback className="bg-muted text-muted-foreground text-sm font-medium">
                      {getInitials(user.user_metadata?.full_name || user.email || 'U')}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-48" align="end">
                <DropdownMenuItem asChild>
                  <Link href="/dashboard">Dashboard</Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleLogout}>
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button asChild variant="ghost" size="sm" className="rounded-full">
              <Link href="/auth">Sign in</Link>
            </Button>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="relative z-10 flex flex-col items-center justify-center flex-1 px-4 md:px-6">
        {/* Logo/Title */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="text-center mb-6"
        >
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-medium tracking-tight text-foreground">
            Explorer
            <span className="ml-2 md:ml-3 text-sm md:text-base font-normal text-muted-foreground tracking-normal">
              v0.1
            </span>
          </h1>
        </motion.div>

        {/* Search bar */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1, ease: 'easeOut' }}
          className="w-full max-w-2xl mb-10"
        >
          <div
            className={cn(
              'flex flex-row items-center gap-3 p-3 rounded-2xl transition-all duration-200',
              'border bg-card',
              isFocused && 'ring-2 ring-primary/50 border-primary/50',
            )}
          >
            <div className="pl-2">
              <Search className="w-5 h-5 text-muted-foreground" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onKeyDown={handleKeyDown}
              placeholder="Transformer"
              className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground outline-none py-2 pr-2 text-lg font-medium"
            />
            <Button onClick={handleSearch} size="icon" className="w-10 h-10 rounded-xl flex-shrink-0">
              <ArrowUp className="w-5 h-5" />
            </Button>
          </div>
        </motion.div>

        {/* Activity Card Stack */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2, ease: 'easeOut' }}
          className="w-full max-w-md mx-auto"
        >
          <ActivityCardStack items={activityCards} />
        </motion.div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 py-4 flex-shrink-0">
        <div className="flex flex-col items-center justify-center gap-2">
          {/* Article count */}
          {/* <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.4 }}
            className="text-center"
          >
            <p className="text-muted-foreground text-[10px] uppercase tracking-widest mb-0.5">
              Articles Available
            </p>
            <p className="text-foreground text-xl font-medium tabular-nums tracking-wide">
              {articleCount.toLocaleString()}
            </p>
          </motion.div> */}

          {/* Footer links */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.5 }}
            className="flex items-center gap-2 text-[10px] text-muted-foreground"
          >
            <Link href="/legal?tab=terms" className="hover:text-foreground transition-colors">
              Terms of Service
            </Link>
            <span className="text-border">·</span>
            <Link href="/legal?tab=privacy" className="hover:text-foreground transition-colors">
              Privacy Policy
            </Link>
            <span className="text-border">·</span>
          </motion.div>
        </div>
      </footer>
    </div>
  );
}
