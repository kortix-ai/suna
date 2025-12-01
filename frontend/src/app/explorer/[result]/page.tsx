'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Sparkles, RefreshCw } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/home/theme-toggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase/client';
import { useRouter, useParams } from 'next/navigation';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';

// Content generator based on topic
function generateContent(topic: string) {
  const title = topic.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return {
    title,
    factChecked: '4 hours ago',
    paragraphs: [
      `${title} (born June 28, 1971) is an engineer, entrepreneur, and business magnate. His companies have pioneered advancements in electric vehicles, digital payments, advanced battery and solar technologies, reusable rockets, global satellite internet, tunnel boring, autonomous driving, brain-machine interfaces, humanoid robots, and AI video and image generation and voice conversing. He holds South African citizenship by birth and Canadian citizenship through his mother. Musk became a U.S. citizen in 2002.`,
      `As of November 28, 2025, Musk is the world's richest individual with an estimated net worth of $480.5 billion, having become the first person to surpass $500 billion in October 2025, establishing him as the richest individual in history, and is projected to become the world's first trillionaire. Musk's wealth is primarily driven from his ownership stakes in Tesla, SpaceX, and xAI.`,
      `In 1995, Musk co-founded Zip2, a software company that provided online business directories and maps, which was sold to Compaq for $307 million in 1999. In 1999, Musk co-founded X.com, an online financial services and payments company, which merged with Confinity on March 30, 2000, forming PayPal. eBay acquired PayPal on October 3, 2002, for $1.5 billion. Musk joined Tesla in 2004 as lead investor and chairman and was granted co-founder status. Musk became CEO in October 2008, directing the development of electric vehicles, autonomous driving technologies, battery energy storage, and solar products that have accelerated the transition to sustainable energy.`,
      `Musk founded SpaceX in 2002 as CEO and chief engineer, pioneering reusable rocket technology to lower launch costs, with the goal of enabling point-to-point rocket travel on Earth for rapid global transport to anywhere in under an hour, and to pursue human settlement on Mars.`,
      `He established Neuralink in 2016 to develop brain-machine interfaces and The Boring Company in 2016 aimed at solving traffic congestion through urban tunneling. In 2015, Musk co-founded OpenAI as a non-profit organization focused on developing safe artificial general intelligence to benefit humanity. In 2022, Musk acquired the social media company Twitter Inc. for $44 billion, rebranding it as X Corp and implementing the "Freedom of Speech, Not Reach" policy to prioritize open discourse amid debates over content moderation.`,
      `He established xAI in 2023 with the stated aim of understanding the universe through the development of artificial intelligence, which acquired X Corp. as a subsidiary in 2025.`,
      `Musk has advocated for policies promoting innovation, including automating jobs with autonomous humanoid robots, population growth, and reduced government intervention, influencing discussions on regulation and free speech. His views and political endorsements have varied. In late 2024, Musk co-led the Department of Government Efficiency (DOGE) initiative, which aimed to dismantle government bureaucracy and significantly reduce federal spending by $2 trillion. Musk departed from DOGE at the conclusion of his 130-day term as a special government employee.`,
    ],
  };
}

export default function ExplorerResultPage() {
  const params = useParams();
  const result = params.result as string;
  const [mounted, setMounted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [content, setContent] = useState<ReturnType<typeof generateContent> | null>(null);
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    setMounted(true);
    const timer = setTimeout(() => {
      setContent(generateContent(result));
      setIsLoading(false);
    }, 500);
    return () => clearTimeout(timer);
  }, [result]);

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    clearUserLocalStorage();
    router.push('/auth');
  };

  const getInitials = (name: string) => {
    return name.split(' ').map((part) => part.charAt(0)).join('').toUpperCase().substring(0, 2);
  };

  if (!mounted) {
    return <div className="min-h-screen w-full bg-background" />;
  }

  return (
    <div className="min-h-screen w-full bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full bg-background">
        <div className="flex items-center h-14 px-6 lg:px-8">
          {/* Left - Logo */}
          <Link href="/explorer" className="flex items-center gap-1.5">
            <span className="text-xl font-medium text-foreground">Explorer</span>
            <span className="text-sm text-muted-foreground">v0.1</span>
          </Link>

          {/* Center - Search */}
          <div className="flex-1 flex justify-center px-12">
            <Link
              href="/explorer"
              className="flex items-center gap-3 h-9 px-4 rounded-lg border border-border/60 bg-transparent hover:bg-muted/40 transition-colors w-full max-w-sm"
            >
              <Search className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground flex-1">Search</span>
              <kbd className="text-[11px] text-muted-foreground/60">⌘K</kbd>
            </Link>
          </div>

          {/* Right */}
          <div className="flex items-center gap-3">
            <ThemeToggle />
            {user && !authLoading ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-8 w-8 rounded-full p-0">
                    <Avatar className="h-8 w-8">
                      <AvatarImage src={user.user_metadata?.avatar_url} />
                      <AvatarFallback className="text-xs bg-muted">
                        {getInitials(user.user_metadata?.full_name || user.email || 'U')}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem asChild>
                    <Link href="/dashboard">Dashboard</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleLogout}>Log out</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button asChild variant="outline" size="sm" className="h-8 rounded-full text-xs px-4">
                <Link href="/auth">Login</Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Main */}
      <AnimatePresence mode="wait">
        {isLoading ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex items-center justify-center min-h-[60vh]"
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
            >
              <RefreshCw className="w-5 h-5 text-muted-foreground/40" />
            </motion.div>
          </motion.div>
        ) : content ? (
          <motion.div
            key="content"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="w-full flex justify-center"
          >
            {/* Content */}
            <main className="w-full max-w-3xl px-6 py-6 lg:py-8">
              {/* Badge */}
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-3">
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Fact-checked by Kortix {content.factChecked}</span>
              </div>

              {/* Title */}
              <h1 className="text-[2.25rem] font-semibold tracking-tight text-foreground mb-6 leading-tight">
                {content.title}
              </h1>

              {/* Paragraphs */}
              <div className="text-[15px] leading-[1.9] text-muted-foreground space-y-4">
                {content.paragraphs.map((text, i) => (
                  <p key={i}>
                    {text}
                    <sup className="text-[10px] text-muted-foreground/50 ml-0.5">
                      [{i * 3 + 1}][{i * 3 + 2}][{i * 3 + 3}]
                    </sup>
                  </p>
                ))}
              </div>
            </main>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
