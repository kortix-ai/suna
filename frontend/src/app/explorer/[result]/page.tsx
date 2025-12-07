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

// Types
interface InfoboxItem { label: string; value: string; }
interface TocEntry { id: string; title: string; }

// Content piece - either a full section or a card in a row
interface ContentPiece {
  id: string;
  title: string;
  description: string;
  type: string;
  isSection: boolean;
  size?: 'quarter' | 'third' | 'half' | 'full';
}

// Row of cards
interface CardRow {
  cards: ContentPiece[];
}

// Page layout
interface PageLayout {
  title: string;
  subtitle: string;
  infobox: InfoboxItem[];
  intro: string;
  toc: TocEntry[];
  content: (ContentPiece | CardRow)[];
}

interface ContentState {
  html: string;
  isStreaming: boolean;
  isComplete: boolean;
}

// Parse the hybrid XML format
function parseLayoutXML(xml: string): { layout: Partial<PageLayout>; closedContent: ContentPiece[] } {
  const layout: Partial<PageLayout> = {};
  const closedContent: ContentPiece[] = [];
  const content: (ContentPiece | CardRow)[] = [];

  // Parse title, subtitle
  const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/);
  if (titleMatch) layout.title = titleMatch[1].trim();
  
  const subtitleMatch = xml.match(/<subtitle>([\s\S]*?)<\/subtitle>/);
  if (subtitleMatch) layout.subtitle = subtitleMatch[1].trim();

  // Parse intro
  const introMatch = xml.match(/<intro>([\s\S]*?)<\/intro>/);
  if (introMatch) layout.intro = introMatch[1].trim();

  // Parse infobox
  const infoboxMatch = xml.match(/<infobox>([\s\S]*?)<\/infobox>/);
  if (infoboxMatch) {
    const items: InfoboxItem[] = [];
    const itemRegex = /<item label="([^"]+)">([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(infoboxMatch[1])) !== null) {
      items.push({ label: match[1], value: match[2].trim() });
    }
    layout.infobox = items;
  }

  // Parse TOC
  const tocMatch = xml.match(/<toc>([\s\S]*?)<\/toc>/);
  if (tocMatch) {
    const entries: TocEntry[] = [];
    const entryRegex = /<entry id="(\d+)">([\s\S]*?)<\/entry>/g;
    let match;
    while ((match = entryRegex.exec(tocMatch[1])) !== null) {
      entries.push({ id: match[1], title: match[2].trim() });
    }
    layout.toc = entries;
  }

  // Parse content (sections and rows of cards)
  const contentMatch = xml.match(/<content>([\s\S]*)/);
  if (contentMatch) {
    const contentXml = contentMatch[1];
    
    // Find all sections (full-width, in-depth)
    const sectionRegex = /<section id="(\d+)" type="([^"]+)">([\s\S]*?)<\/section>/g;
    let sectionMatch;
    while ((sectionMatch = sectionRegex.exec(contentXml)) !== null) {
      const sectionContent = sectionMatch[3];
      const titleMatch = sectionContent.match(/<title>([\s\S]*?)<\/title>/);
      const descMatch = sectionContent.match(/<desc>([\s\S]*?)<\/desc>/);
      
      const piece: ContentPiece = {
        id: sectionMatch[1],
        type: sectionMatch[2],
        title: titleMatch ? titleMatch[1].trim() : '',
        description: descMatch ? descMatch[1].trim() : '',
        isSection: true,
        size: 'full'
      };
      closedContent.push(piece);
      content.push(piece);
    }

    // Find all rows of cards
    const rowRegex = /<row>([\s\S]*?)<\/row>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(contentXml)) !== null) {
      const rowContent = rowMatch[1];
      const cards: ContentPiece[] = [];
      
      const cardRegex = /<card id="(\d+)" size="([^"]+)" type="([^"]+)">([\s\S]*?)<\/card>/g;
      let cardMatch;
      while ((cardMatch = cardRegex.exec(rowContent)) !== null) {
        const cardContent = cardMatch[4];
        const titleMatch = cardContent.match(/<title>([\s\S]*?)<\/title>/);
        const descMatch = cardContent.match(/<desc>([\s\S]*?)<\/desc>/);
        
        const card: ContentPiece = {
          id: cardMatch[1],
          size: cardMatch[2] as ContentPiece['size'],
          type: cardMatch[3],
          title: titleMatch ? titleMatch[1].trim() : '',
          description: descMatch ? descMatch[1].trim() : '',
          isSection: false
        };
        cards.push(card);
        closedContent.push(card);
      }
      
      if (cards.length > 0) {
        content.push({ cards });
      }
    }
  }

  layout.content = content;
  return { layout, closedContent };
}

// Check if item is a CardRow
function isCardRow(item: ContentPiece | CardRow): item is CardRow {
  return 'cards' in item;
}

// Content renderer with Shadow DOM
function ContentRenderer({ html, isDark }: { html: string; isDark: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRootRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    if (!shadowRootRef.current) {
      try {
        shadowRootRef.current = containerRef.current.attachShadow({ mode: 'open' });
      } catch { return; }
    }

    const vars = isDark ? `
      --kp-bg: #0a0a0a;
      --kp-card: #171717;
      --kp-border: #262626;
      --kp-text: #fafafa;
      --kp-muted: #a1a1aa;
      --kp-primary: #8b5cf6;
    ` : `
      --kp-bg: #ffffff;
      --kp-card: #f5f5f5;
      --kp-border: #e5e5e5;
      --kp-text: #171717;
      --kp-muted: #525252;
      --kp-primary: #7c3aed;
    `;

    const baseStyles = `
      :host { display: block; ${vars} }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      .kp-section, .kp-card {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: var(--kp-text);
        font-size: 15px;
        line-height: 1.7;
      }
      h1, h2, h3, h4 { color: var(--kp-text); font-weight: 600; }
      h2 { font-size: 1.5rem; margin-bottom: 1rem; }
      h3 { font-size: 1.15rem; margin: 1.5rem 0 0.75rem; }
      p { color: var(--kp-muted); margin-bottom: 1rem; }
      a { color: var(--kp-primary); text-decoration: none; }
      ul, ol { color: var(--kp-muted); padding-left: 1.5rem; margin-bottom: 1rem; }
      li { margin-bottom: 0.5rem; }
      strong { color: var(--kp-text); }
    `;

    shadowRootRef.current.innerHTML = `<style>${baseStyles}</style>${html || ''}`;
  }, [html, isDark]);

  return <div ref={containerRef} className="w-full h-full" />;
}

export default function ExplorerResultPage() {
  const params = useParams();
  const result = params.result as string;
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(true);

  const [isPlanning, setIsPlanning] = useState(true);
  const [layout, setLayout] = useState<Partial<PageLayout>>({});
  
  const activeStreamsRef = useRef<Set<string>>(new Set());
  const plannerStartedRef = useRef(false);
  const [contentStates, setContentStates] = useState<Record<string, ContentState>>({});

  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const eventSourceRef = useRef<EventSource | null>(null);
  const contentSourcesRef = useRef<Map<string, EventSource>>(new Map());

  const displayTopic = useMemo(() => decodeURIComponent(result).replace(/-/g, ' '), [result]);

  // Track theme
  useEffect(() => {
    const checkTheme = () => setIsDark(document.documentElement.classList.contains('dark'));
    checkTheme();
    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Start content generation
  const startContentGeneration = useCallback((piece: ContentPiece, topic: string) => {
    if (activeStreamsRef.current.has(piece.id)) return;
    activeStreamsRef.current.add(piece.id);

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    const params = new URLSearchParams({
      title: piece.title,
      description: piece.description,
      type: piece.type,
      size: piece.size || 'full',
      is_section: piece.isSection ? 'true' : 'false',
      topic,
    });
    const streamUrl = `${apiUrl}/api/explore/content/${piece.id}?${params.toString()}`;

    setContentStates(prev => ({
      ...prev,
      [piece.id]: { html: '', isStreaming: true, isComplete: false }
    }));

    const eventSource = new EventSource(streamUrl);
    contentSourcesRef.current.set(piece.id, eventSource);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'content') {
          setContentStates(prev => ({
            ...prev,
            [piece.id]: { ...prev[piece.id], html: (prev[piece.id]?.html || '') + data.content }
          }));
        } else if (data.type === 'done') {
          setContentStates(prev => ({
            ...prev,
            [piece.id]: { ...prev[piece.id], isStreaming: false, isComplete: true }
          }));
          eventSource.close();
          contentSourcesRef.current.delete(piece.id);
        }
      } catch (e) { console.error('Parse error:', e); }
    };

    eventSource.onerror = () => {
      setContentStates(prev => ({ ...prev, [piece.id]: { ...prev[piece.id], isStreaming: false } }));
      eventSource.close();
      contentSourcesRef.current.delete(piece.id);
    };
  }, []);

  // Main planner effect
  useEffect(() => {
    setMounted(true);
    if (plannerStartedRef.current) return;
    plannerStartedRef.current = true;

    const processedIds = new Set<string>();
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    const streamUrl = `${apiUrl}/api/explore/${encodeURIComponent(result)}`;

    const eventSource = new EventSource(streamUrl);
    eventSourceRef.current = eventSource;
    let accumulatedXML = '';

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'content') {
          accumulatedXML += data.content;
          const { layout: parsedLayout, closedContent } = parseLayoutXML(accumulatedXML);
          setLayout(parsedLayout);
          
          closedContent.forEach(piece => {
            if (!processedIds.has(piece.id)) {
              processedIds.add(piece.id);
              startContentGeneration(piece, decodeURIComponent(result).replace(/-/g, ' '));
            }
          });
        } else if (data.type === 'done') {
          setIsPlanning(false);
          eventSource.close();
        }
      } catch (e) { console.error('Parse error:', e); }
    };

    eventSource.onerror = () => { setIsPlanning(false); eventSource.close(); };

    return () => {
      eventSourceRef.current?.close();
      contentSourcesRef.current.forEach(es => es.close());
      contentSourcesRef.current.clear();
      plannerStartedRef.current = false;
      activeStreamsRef.current.clear();
    };
  }, [result, startContentGeneration]);

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    clearUserLocalStorage();
    router.push('/auth');
  };

  const getInitials = (name: string) => name.split(' ').map(p => p.charAt(0)).join('').toUpperCase().substring(0, 2);

  if (!mounted) return <div className="min-h-screen w-full bg-background" />;

  const contentItems = layout.content || [];
  const toc = layout.toc || [];
  const infobox = layout.infobox || [];
  const isAnyStreaming = isPlanning || Object.values(contentStates).some(s => s.isStreaming);

  const getColSpan = (size?: string) => {
    switch (size) {
      case 'quarter': return 'col-span-12 sm:col-span-6 lg:col-span-3';
      case 'third': return 'col-span-12 sm:col-span-6 lg:col-span-4';
      case 'half': return 'col-span-12 lg:col-span-6';
      default: return 'col-span-12';
    }
  };

  return (
    <div className="min-h-screen w-full bg-background">
      {/* Background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-muted/30 via-transparent to-transparent dark:from-primary/5" />
        <div className="absolute top-0 left-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-[150px] -translate-x-1/2 -translate-y-1/2" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] bg-primary/5 rounded-full blur-[120px] translate-x-1/3 translate-y-1/3" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-50 w-full bg-background/80 backdrop-blur-xl border-b border-border/40">
        <div className="flex items-center justify-between h-16 px-4 md:px-6 max-w-[1600px] mx-auto">
          <Link href="/explorer" className="flex items-center gap-3">
            <KortixLogo size={18} variant="logomark" />
            <span className="text-lg font-medium text-foreground">Explorer</span>
            <span className="text-sm text-muted-foreground">v0.2</span>
          </Link>

          <div className="flex-1 flex justify-center px-8 max-w-xl mx-auto">
            <Link href="/explorer" className={cn(
              "flex items-center gap-3 h-10 px-4 rounded-2xl w-full",
              "border bg-card hover:bg-accent/50 transition-colors"
            )}>
              <Search className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground flex-1">Search anything...</span>
              <kbd className="text-xs text-muted-foreground/60 font-mono">⌘K</kbd>
            </Link>
          </div>

          <div className="flex items-center gap-3">
            <ThemeToggle />
            {user && !authLoading ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-9 w-9 rounded-full p-0 border border-border hover:bg-accent">
                    <Avatar className="h-9 w-9">
                      <AvatarImage src={user.user_metadata?.avatar_url} />
                      <AvatarFallback className="bg-muted text-muted-foreground text-sm font-medium">
                        {getInitials(user.user_metadata?.full_name || user.email || 'U')}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem asChild><Link href="/dashboard">Dashboard</Link></DropdownMenuItem>
                  <DropdownMenuItem onClick={handleLogout}>Log out</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button asChild variant="ghost" size="sm" className="rounded-full">
                <Link href="/auth">Sign in</Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Main Layout */}
      <div className="max-w-[1600px] mx-auto flex relative">
        {/* Sidebar */}
        <aside className="hidden lg:block w-72 flex-shrink-0 border-r border-border/40">
          <nav className="sticky top-16 p-6 max-h-[calc(100vh-64px)] overflow-y-auto">
            {/* Status */}
            <div className="flex items-center gap-2 mb-6">
              {isAnyStreaming ? (
                <>
                  <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  <span className="text-sm text-primary font-medium">Generating...</span>
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 text-emerald-500" />
                  <span className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">Complete</span>
                </>
              )}
            </div>

            {/* TOC */}
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Contents</div>
            {toc.length > 0 ? (
              <ul className="space-y-1 mb-8">
                {toc.map((entry) => (
                  <li key={entry.id}>
                    <a href={`#content-${entry.id}`}
                      className="flex items-center gap-2 py-2 px-3 -mx-3 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
                      <span className="text-xs text-muted-foreground/50 w-4">{entry.id}</span>
                      <span className="truncate">{entry.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="space-y-2 mb-8">
                {[1,2,3,4].map(i => <div key={i} className="h-8 bg-muted/30 rounded-lg animate-pulse" />)}
              </div>
            )}

            {/* Infobox */}
            {infobox.length > 0 && (
              <>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">Quick Facts</div>
                <div className="space-y-4">
                  {infobox.map((item, i) => (
                    <div key={i}>
                      <div className="text-xs text-muted-foreground mb-0.5">{item.label}</div>
                      <div className="text-sm text-foreground font-medium">{item.value}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0 p-6 md:p-8 lg:p-10">
          {/* Title */}
          <AnimatePresence mode="wait">
            <motion.header initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} className="mb-6">
              <h1 className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tight text-foreground mb-2">
                {layout.title || displayTopic}
              </h1>
              {layout.subtitle && <p className="text-lg text-muted-foreground">{layout.subtitle}</p>}
            </motion.header>
          </AnimatePresence>

          {/* Intro */}
          {layout.intro && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
              className="mb-10 text-base text-muted-foreground leading-relaxed max-w-4xl prose prose-neutral dark:prose-invert">
              {layout.intro}
            </motion.div>
          )}

          {/* Mobile TOC */}
          {toc.length > 0 && (
            <div className="lg:hidden mb-8 p-4 bg-card rounded-2xl border border-border/40">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Contents</div>
              <div className="flex flex-wrap gap-2">
                {toc.map((entry) => (
                  <a key={entry.id} href={`#content-${entry.id}`}
                    className="text-sm px-3 py-1.5 bg-muted/50 rounded-lg border border-border/40 text-muted-foreground hover:text-foreground transition-colors">
                    {entry.title}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Content - Sections and Card Rows */}
          <div className="space-y-8">
            {contentItems.map((item, idx) => {
              if (isCardRow(item)) {
                // Render card row as a grid
                return (
                  <motion.div key={`row-${idx}`} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.05 }} className="grid grid-cols-12 gap-4 md:gap-6">
                    {item.cards.map((card) => {
                      const state = contentStates[card.id];
                      return (
                        <div key={card.id} id={`content-${card.id}`} className={cn(getColSpan(card.size), "scroll-mt-24")}>
                          <div className="h-full rounded-2xl border border-border/40 bg-card overflow-hidden hover:border-border/60 hover:shadow-lg transition-all">
                            <div className="flex items-center justify-between px-4 py-3 border-b border-border/30 bg-muted/20">
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground/50 font-mono">{card.id}</span>
                                <h3 className="text-sm font-semibold text-foreground truncate">{card.title}</h3>
                              </div>
                              {state?.isStreaming && <Loader2 className="w-3 h-3 animate-spin text-primary" />}
                              {state?.isComplete && <Zap className="w-3 h-3 text-emerald-500" />}
                            </div>
                            <div className="p-4 min-h-[100px]">
                              {state?.html ? (
                                <ContentRenderer html={state.html} isDark={isDark} />
                              ) : (
                                <div className="flex items-center justify-center h-full min-h-[80px]">
                                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/50" />
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </motion.div>
                );
              } else {
                // Render major section (full width)
                const state = contentStates[item.id];
                return (
                  <motion.section key={item.id} id={`content-${item.id}`} initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.05 }} className="scroll-mt-24">
                    <div className="rounded-2xl border border-border/40 bg-card overflow-hidden hover:border-border/60 transition-colors">
                      <div className="flex items-center justify-between px-6 py-4 border-b border-border/30 bg-muted/20">
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-muted-foreground/50 font-mono">{item.id}</span>
                          <h2 className="text-lg font-semibold text-foreground">{item.title}</h2>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground capitalize">{item.type}</span>
                          {state?.isStreaming && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
                          {state?.isComplete && <Zap className="w-4 h-4 text-emerald-500" />}
                        </div>
                      </div>
                      <div className="p-6 min-h-[200px]">
                        {state?.html ? (
                          <ContentRenderer html={state.html} isDark={isDark} />
                        ) : (
                          <div className="flex items-center justify-center h-full min-h-[150px]">
                            <div className="flex items-center gap-3 text-muted-foreground">
                              <Loader2 className="w-5 h-5 animate-spin" />
                              <span className="text-sm">Generating {item.type} content...</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </motion.section>
                );
              }
            })}
          </div>

          {/* Loading skeleton */}
          {isPlanning && contentItems.length === 0 && (
            <div className="space-y-6">
              <div className="h-48 bg-card rounded-2xl border border-border/40 animate-pulse" />
              <div className="grid grid-cols-12 gap-4">
                <div className="col-span-3 h-32 bg-card rounded-2xl border border-border/40 animate-pulse" />
                <div className="col-span-3 h-32 bg-card rounded-2xl border border-border/40 animate-pulse" />
                <div className="col-span-3 h-32 bg-card rounded-2xl border border-border/40 animate-pulse" />
                <div className="col-span-3 h-32 bg-card rounded-2xl border border-border/40 animate-pulse" />
              </div>
              <div className="h-64 bg-card rounded-2xl border border-border/40 animate-pulse" />
            </div>
          )}

          {/* Footer */}
          <motion.footer initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} className="mt-12 pt-6 border-t border-border/30">
            <p className="text-xs text-muted-foreground">
              Generated by <span className="font-medium text-foreground">Explorer</span> · Wikipedia-style parallel AI content generation
            </p>
          </motion.footer>
        </main>
      </div>
    </div>
  );
}
