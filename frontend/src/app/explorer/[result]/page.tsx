'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Zap, Loader2 } from 'lucide-react';
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
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase/client';
import { useRouter, useParams } from 'next/navigation';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { cn } from '@/lib/utils';

// Types for parsed layout
interface Section {
  id: string;
  title: string;
  description: string;
  type: string;
}

interface Row {
  layout: 'full' | '2-col' | '3-col' | 'sidebar-left' | 'sidebar-right';
  sections: Section[];
}

interface PageLayout {
  title: string;
  hero: {
    headline: string;
    subheadline: string;
  };
  rows: Row[];
}

// Section content state
interface SectionContent {
  html: string;
  isStreaming: boolean;
  isComplete: boolean;
}

// Parse layout XML incrementally with row support
function parseLayoutXML(xml: string): { layout: Partial<PageLayout>; closedSections: Section[] } {
  const layout: Partial<PageLayout> = {};
  const closedSections: Section[] = [];
  const rows: Row[] = [];

  // Parse title
  const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/);
  if (titleMatch) {
    layout.title = titleMatch[1].trim();
  }

  // Parse hero
  const heroMatch = xml.match(/<hero>([\s\S]*?)<\/hero>/);
  if (heroMatch) {
    const headlineMatch = heroMatch[1].match(/<headline>([\s\S]*?)<\/headline>/);
    const subheadlineMatch = heroMatch[1].match(/<subheadline>([\s\S]*?)<\/subheadline>/);
    layout.hero = {
      headline: headlineMatch ? headlineMatch[1].trim() : '',
      subheadline: subheadlineMatch ? subheadlineMatch[1].trim() : '',
    };
  }

  // Parse rows with sections
  const rowRegex = /<row layout="([^"]+)">([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowLayout = rowMatch[1] as Row['layout'];
    const rowContent = rowMatch[2];
    const rowSections: Section[] = [];

    // Parse sections within this row
    const sectionRegex = /<section id="(\d+)">([\s\S]*?)<\/section>/g;
    let sectionMatch;
    while ((sectionMatch = sectionRegex.exec(rowContent)) !== null) {
      const sectionContent = sectionMatch[2];
      const sectionTitleMatch = sectionContent.match(/<title>([\s\S]*?)<\/title>/);
      const descMatch = sectionContent.match(/<description>([\s\S]*?)<\/description>/);
      const typeMatch = sectionContent.match(/<type>([\s\S]*?)<\/type>/);

      const section: Section = {
        id: sectionMatch[1],
        title: sectionTitleMatch ? sectionTitleMatch[1].trim() : '',
        description: descMatch ? descMatch[1].trim() : '',
        type: typeMatch ? typeMatch[1].trim() : 'text',
      };

      rowSections.push(section);
      closedSections.push(section);
    }

    if (rowSections.length > 0) {
      rows.push({ layout: rowLayout, sections: rowSections });
    }
  }

  // Fallback: parse sections outside of rows (old format)
  if (rows.length === 0) {
    const sectionRegex = /<section id="(\d+)">([\s\S]*?)<\/section>/g;
    let match;
    while ((match = sectionRegex.exec(xml)) !== null) {
      const sectionContent = match[2];
      const sectionTitleMatch = sectionContent.match(/<title>([\s\S]*?)<\/title>/);
      const descMatch = sectionContent.match(/<description>([\s\S]*?)<\/description>/);
      const typeMatch = sectionContent.match(/<type>([\s\S]*?)<\/type>/);

      const section: Section = {
        id: match[1],
        title: sectionTitleMatch ? sectionTitleMatch[1].trim() : '',
        description: descMatch ? descMatch[1].trim() : '',
        type: typeMatch ? typeMatch[1].trim() : 'text',
      };

      closedSections.push(section);
      rows.push({ layout: 'full', sections: [section] });
    }
  }

  layout.rows = rows;
  return { layout, closedSections };
}

// Component to render section content using Shadow DOM for style isolation
function SectionRenderer({ html, sectionId, isStreaming, isDark }: { html: string; sectionId: string; isStreaming: boolean; isDark: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRootRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create shadow root if not exists
    if (!shadowRootRef.current) {
      try {
        shadowRootRef.current = containerRef.current.attachShadow({ mode: 'open' });
      } catch {
        // Shadow root already attached
        return;
      }
    }

    // Theme-aware CSS variables
    const baseStyles = isDark ? `
      :host {
        display: block;
        --kp-bg: #0a0a0a;
        --kp-card: #141414;
        --kp-border: #262626;
        --kp-text: #fafafa;
        --kp-muted: #a1a1aa;
        --kp-primary: #8b5cf6;
        --kp-accent: #06b6d4;
      }
    ` : `
      :host {
        display: block;
        --kp-bg: #ffffff;
        --kp-card: #f8f8f8;
        --kp-border: #e5e5e5;
        --kp-text: #171717;
        --kp-muted: #525252;
        --kp-primary: #7c3aed;
        --kp-accent: #0891b2;
      }
    `;

    const commonStyles = `
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      .kp-wrapper {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
        background: var(--kp-bg);
        color: var(--kp-text);
        line-height: 1.6;
        min-height: 100px;
        padding: 1.5rem;
        border-radius: 0.75rem;
      }
      h1, h2, h3, h4, h5, h6 {
        color: var(--kp-text);
        font-weight: 600;
        margin-bottom: 1rem;
      }
      p {
        color: var(--kp-muted);
        margin-bottom: 1rem;
      }
      a {
        color: var(--kp-primary);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
      ul, ol {
        color: var(--kp-muted);
        padding-left: 1.5rem;
        margin-bottom: 1rem;
      }
      li {
        margin-bottom: 0.5rem;
      }
      code {
        background: var(--kp-card);
        padding: 0.2rem 0.4rem;
        border-radius: 4px;
        font-size: 0.9em;
      }
      pre {
        background: var(--kp-card);
        padding: 1rem;
        border-radius: 8px;
        overflow-x: auto;
        margin-bottom: 1rem;
      }
      pre code {
        background: none;
        padding: 0;
      }
      blockquote {
        border-left: 3px solid var(--kp-primary);
        padding-left: 1rem;
        margin: 1rem 0;
        color: var(--kp-muted);
        font-style: italic;
      }
      img {
        max-width: 100%;
        border-radius: 8px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 1rem;
      }
      th, td {
        border: 1px solid var(--kp-border);
        padding: 0.75rem;
        text-align: left;
      }
      th {
        background: var(--kp-card);
        font-weight: 600;
      }
    `;

    // Update shadow DOM content
    shadowRootRef.current.innerHTML = `
      <style>${baseStyles}${commonStyles}</style>
      <div class="kp-wrapper">${html || '<p style="color: var(--kp-muted); text-align: center;">Loading content...</p>'}</div>
    `;
  }, [html, isDark]);

  return (
    <div className="relative">
      <div 
        ref={containerRef} 
        className="rounded-xl overflow-hidden bg-background min-h-[150px]"
      />
      {isStreaming && (
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-primary/0 via-primary to-primary/0 animate-pulse" />
      )}
    </div>
  );
}

export default function ExplorerResultPage() {
  const params = useParams();
  const result = params.result as string;
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(true);

  // Planner state
  const [isPlanning, setIsPlanning] = useState(true);
  const [rawLayoutXML, setRawLayoutXML] = useState('');
  const [layout, setLayout] = useState<Partial<PageLayout>>({});
  
  // Use refs to track active streams and prevent duplicates (React Strict Mode safe)
  const activeStreamsRef = useRef<Set<string>>(new Set());
  const plannerStartedRef = useRef(false);

  // Section content state
  const [sectionContents, setSectionContents] = useState<Record<string, SectionContent>>({});

  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const eventSourceRef = useRef<EventSource | null>(null);
  const contentSourcesRef = useRef<Map<string, EventSource>>(new Map());

  // Derive display topic from URL param
  const displayTopic = useMemo(() => {
    return decodeURIComponent(result).replace(/-/g, ' ');
  }, [result]);

  // Track theme changes
  useEffect(() => {
    const checkTheme = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    
    checkTheme();
    
    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    
    return () => observer.disconnect();
  }, []);

  // Start content generation for a section (React Strict Mode safe)
  const startSectionContent = useCallback((section: Section, topic: string) => {
    // Prevent duplicate streams
    if (activeStreamsRef.current.has(section.id)) {
      console.log(`⏭️ Section ${section.id} stream already active, skipping`);
      return;
    }
    
    activeStreamsRef.current.add(section.id);
    
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    const params = new URLSearchParams({
      title: section.title,
      description: section.description,
      type: section.type,
      topic: topic,
    });
    const streamUrl = `${apiUrl}/api/explore/content/${section.id}?${params.toString()}`;

    console.log(`🎨 Starting content stream for section ${section.id}: ${section.title}`);

    // Initialize section content state
    setSectionContents(prev => ({
      ...prev,
      [section.id]: { html: '', isStreaming: true, isComplete: false }
    }));

    const eventSource = new EventSource(streamUrl);
    contentSourcesRef.current.set(section.id, eventSource);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'content') {
          setSectionContents(prev => ({
            ...prev,
            [section.id]: {
              ...prev[section.id],
              html: (prev[section.id]?.html || '') + data.content,
            }
          }));
        } else if (data.type === 'done') {
          console.log(`✅ Section ${section.id} content complete`);
          setSectionContents(prev => ({
            ...prev,
            [section.id]: {
              ...prev[section.id],
              isStreaming: false,
              isComplete: true,
            }
          }));
          eventSource.close();
          contentSourcesRef.current.delete(section.id);
        }
      } catch (e) {
        console.error('Parse error:', e);
      }
    };

    eventSource.onerror = () => {
      setSectionContents(prev => ({
        ...prev,
        [section.id]: {
          ...prev[section.id],
          isStreaming: false,
        }
      }));
      eventSource.close();
      contentSourcesRef.current.delete(section.id);
    };
  }, []);

  // Main effect to start planning and handle content streams
  useEffect(() => {
    setMounted(true);
    
    // Prevent duplicate planner streams (React Strict Mode)
    if (plannerStartedRef.current) {
      console.log('⏭️ Planner already started, skipping');
      return;
    }
    plannerStartedRef.current = true;

    const processedIds = new Set<string>();

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    const streamUrl = `${apiUrl}/api/explore/${encodeURIComponent(result)}`;

    console.log('📋 Starting planner stream from:', streamUrl);

    const eventSource = new EventSource(streamUrl);
    eventSourceRef.current = eventSource;
    
    let accumulatedXML = '';

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'content') {
          accumulatedXML += data.content;
          
          // Parse the accumulated XML
          const { layout: parsedLayout, closedSections } = parseLayoutXML(accumulatedXML);
          setLayout(parsedLayout);
          setRawLayoutXML(accumulatedXML);
          
          // Check for new closed sections and start content generation
          closedSections.forEach(section => {
            if (!processedIds.has(section.id)) {
              processedIds.add(section.id);
              startSectionContent(section, decodeURIComponent(result).replace(/-/g, ' '));
            }
          });
        } else if (data.type === 'done') {
          console.log('✅ Planner stream complete');
          setIsPlanning(false);
          eventSource.close();
        }
      } catch (e) {
        console.error('Parse error:', e);
      }
    };

    eventSource.onerror = () => {
      setIsPlanning(false);
      eventSource.close();
    };

    // Cleanup
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      contentSourcesRef.current.forEach(es => es.close());
      contentSourcesRef.current.clear();
      // Reset refs for next mount
      plannerStartedRef.current = false;
      activeStreamsRef.current.clear();
    };
  }, [result, startSectionContent]);

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

  const rows = layout.rows || [];
  const isAnyStreaming = isPlanning || Object.values(sectionContents).some(s => s.isStreaming);

  // Get all sections for TOC
  const allSections = rows.flatMap(row => row.sections);

  // Grid class based on layout
  const getGridClass = (layoutType: Row['layout']) => {
    switch (layoutType) {
      case '2-col': return 'grid-cols-1 md:grid-cols-2';
      case '3-col': return 'grid-cols-1 md:grid-cols-3';
      case 'sidebar-left': return 'grid-cols-1 md:grid-cols-[minmax(200px,30%)_1fr]';
      case 'sidebar-right': return 'grid-cols-1 md:grid-cols-[1fr_minmax(200px,30%)]';
      default: return 'grid-cols-1';
    }
  };

  return (
    <div className="min-h-screen w-full bg-background">
      {/* Gradient background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-muted/30 via-transparent to-transparent dark:from-primary/5" />
        <div className="absolute top-0 left-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-[150px] -translate-x-1/2 -translate-y-1/2" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] bg-primary/5 rounded-full blur-[120px] translate-x-1/3 translate-y-1/3" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-50 w-full bg-background/80 backdrop-blur-xl border-b border-border/40">
        <div className="flex items-center h-14 px-6 lg:px-8">
          <Link href="/explorer" className="flex items-center gap-3">
            <KortixLogo size={18} variant="logomark" />
            <span className="text-lg font-medium text-foreground tracking-tight">Explorer</span>
          </Link>

          <div className="flex-1 flex justify-center px-12">
            <Link
              href="/explorer"
              className="flex items-center gap-3 h-9 px-4 rounded-full border border-border/60 bg-muted/30 hover:bg-muted/50 transition-all w-full max-w-md group"
            >
              <Search className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              <span className="text-sm text-muted-foreground flex-1">Search anything...</span>
              <kbd className="text-[10px] text-muted-foreground/60 bg-background/60 px-1.5 py-0.5 rounded font-mono">⌘K</kbd>
            </Link>
          </div>

          <div className="flex items-center gap-3">
            <ThemeToggle />
            {user && !authLoading ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-8 w-8 rounded-full p-0">
                    <Avatar className="h-8 w-8">
                      <AvatarImage src={user.user_metadata?.avatar_url} />
                      <AvatarFallback className="text-xs bg-muted text-muted-foreground">
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
              <Button asChild variant="ghost" size="sm" className="h-8 rounded-full text-xs px-4">
                <Link href="/auth">Sign in</Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="w-full max-w-6xl mx-auto px-6 py-8 lg:py-12 relative">
        {/* Status indicator */}
        <div className="flex items-center gap-2 mb-8">
          {isAnyStreaming ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center gap-2"
            >
              <div className="relative">
                <div className="w-2 h-2 rounded-full bg-primary animate-ping absolute" />
                <div className="w-2 h-2 rounded-full bg-primary" />
              </div>
              <span className="text-xs font-medium text-primary uppercase tracking-wider">
                {isPlanning ? 'Planning layout...' : 'Generating content...'}
              </span>
            </motion.div>
          ) : (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400"
            >
              <Zap className="w-3.5 h-3.5" />
              <span className="text-xs font-medium uppercase tracking-wider">Complete</span>
            </motion.div>
          )}
        </div>

        {/* Hero Section */}
        <AnimatePresence mode="wait">
          {layout.hero ? (
            <motion.div
              key="hero"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="mb-12"
            >
              <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-foreground mb-4 leading-tight">
                {layout.hero.headline || layout.title || displayTopic}
              </h1>
              {layout.hero.subheadline && (
                <p className="text-lg md:text-xl text-muted-foreground max-w-3xl leading-relaxed">
                  {layout.hero.subheadline}
                </p>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="hero-skeleton"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mb-12"
            >
              <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-foreground mb-4 capitalize">
                {displayTopic}
              </h1>
              <div className="h-6 w-2/3 bg-muted/50 rounded-lg animate-pulse" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Table of Contents */}
        {allSections.length > 0 && (
          <motion.nav
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="mb-12 p-6 rounded-2xl bg-card/50 border border-border/50 backdrop-blur-sm"
          >
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
              Contents
            </h2>
            <ol className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {allSections.map((section, i) => (
                <motion.li
                  key={section.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="flex items-center gap-3"
                >
                  <span className="flex-shrink-0 w-6 h-6 rounded-md bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                    {section.id}
                  </span>
                  <a
                    href={`#section-${section.id}`}
                    className="text-foreground/70 hover:text-foreground transition-colors text-sm"
                  >
                    {section.title}
                  </a>
                  {sectionContents[section.id]?.isStreaming && (
                    <Loader2 className="w-3 h-3 animate-spin text-primary" />
                  )}
                  {sectionContents[section.id]?.isComplete && (
                    <Zap className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                  )}
                </motion.li>
              ))}
            </ol>
          </motion.nav>
        )}

        {/* Content Rows with Layout */}
        <div className="space-y-8">
          {rows.map((row, rowIndex) => (
            <motion.div
              key={rowIndex}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 + rowIndex * 0.1 }}
              className={cn('grid gap-6', getGridClass(row.layout))}
            >
              {row.sections.map((section) => {
                const content = sectionContents[section.id];

                return (
                  <motion.section
                    key={section.id}
                    id={`section-${section.id}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="scroll-mt-20"
                  >
                    {/* Section header */}
                    <div className="flex items-start gap-3 mb-4">
                      <span className="flex-shrink-0 w-7 h-7 rounded-lg bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center shadow-lg shadow-primary/20">
                        {section.id}
                      </span>
                      <div className="flex-1 min-w-0">
                        <h2 className="text-xl font-semibold text-foreground truncate">{section.title}</h2>
                        <p className="text-sm text-muted-foreground line-clamp-2">{section.description}</p>
                      </div>
                    </div>

                    {/* Content container with Shadow DOM */}
                    <div className={cn(
                      "relative rounded-xl overflow-hidden",
                      "border border-border/50 bg-card/30",
                      !content?.html && "min-h-[200px]"
                    )}>
                      {content?.html ? (
                        <SectionRenderer 
                          html={content.html} 
                          sectionId={section.id}
                          isStreaming={content.isStreaming}
                          isDark={isDark}
                        />
                      ) : (
                        <div className="p-8 flex items-center justify-center min-h-[200px]">
                          <div className="flex flex-col items-center gap-3 text-muted-foreground">
                            <Loader2 className="w-6 h-6 animate-spin text-primary" />
                            <span className="text-sm">Generating {section.type} content...</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </motion.section>
                );
              })}
            </motion.div>
          ))}
        </div>

        {/* Loading skeleton for sections */}
        {isPlanning && rows.length === 0 && (
          <div className="space-y-8">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-7 h-7 rounded-lg bg-muted/50" />
                  <div className="space-y-2 flex-1">
                    <div className="h-5 w-48 bg-muted/50 rounded" />
                    <div className="h-4 w-64 bg-muted/30 rounded" />
                  </div>
                </div>
                <div className="h-48 rounded-xl bg-muted/20" />
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="mt-16 p-4 rounded-xl bg-card/30 border border-border/30"
        >
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Generated by <span className="font-medium text-foreground">Explorer</span> using parallel AI content generation.
            Each section is generated independently for faster results.
          </p>
        </motion.div>
      </main>
    </div>
  );
}
