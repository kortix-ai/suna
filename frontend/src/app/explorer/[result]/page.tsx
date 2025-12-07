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
interface InfoboxItem {
  label: string;
  value: string;
}

interface TocEntry {
  id: string;
  title: string;
}

interface GridCell {
  id: string;
  size: 'full' | 'half' | 'third' | 'quarter';
  type: string;
  title: string;
  description: string;
}

interface PageLayout {
  title: string;
  subtitle: string;
  infobox: InfoboxItem[];
  intro: string;
  toc: TocEntry[];
  cells: GridCell[];
}

interface CellContent {
  html: string;
  isStreaming: boolean;
  isComplete: boolean;
}

// Parse layout XML
function parseLayoutXML(xml: string): { layout: Partial<PageLayout>; closedCells: GridCell[] } {
  const layout: Partial<PageLayout> = {};
  const closedCells: GridCell[] = [];

  // Parse title
  const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/);
  if (titleMatch) layout.title = titleMatch[1].trim();

  // Parse subtitle
  const subtitleMatch = xml.match(/<subtitle>([\s\S]*?)<\/subtitle>/);
  if (subtitleMatch) layout.subtitle = subtitleMatch[1].trim();

  // Parse intro
  const introMatch = xml.match(/<intro>([\s\S]*?)<\/intro>/);
  if (introMatch) layout.intro = introMatch[1].trim();

  // Parse infobox items
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

  // Parse TOC entries
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

  // Parse grid cells
  const cellRegex = /<cell id="(\d+)" size="([^"]+)" type="([^"]+)">([\s\S]*?)<\/cell>/g;
  let cellMatch;
  while ((cellMatch = cellRegex.exec(xml)) !== null) {
    const cellContent = cellMatch[4];
    const cellTitleMatch = cellContent.match(/<title>([\s\S]*?)<\/title>/);
    const descMatch = cellContent.match(/<desc>([\s\S]*?)<\/desc>/);
    
    closedCells.push({
      id: cellMatch[1],
      size: cellMatch[2] as GridCell['size'],
      type: cellMatch[3],
      title: cellTitleMatch ? cellTitleMatch[1].trim() : '',
      description: descMatch ? descMatch[1].trim() : '',
    });
  }

  layout.cells = closedCells;
  return { layout, closedCells };
}

// Cell renderer with Shadow DOM
function CellRenderer({ html, isDark }: { html: string; isDark: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRootRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    if (!shadowRootRef.current) {
      try {
        shadowRootRef.current = containerRef.current.attachShadow({ mode: 'open' });
      } catch {
        return;
      }
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
      .kp-cell {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: var(--kp-text);
        font-size: 15px;
        line-height: 1.6;
      }
      h1, h2, h3 { color: var(--kp-text); font-weight: 600; }
      h2 { font-size: 1.25rem; margin-bottom: 0.75rem; }
      h3 { font-size: 1.1rem; margin-bottom: 0.5rem; }
      p { color: var(--kp-muted); margin-bottom: 0.75rem; }
      a { color: var(--kp-primary); text-decoration: none; }
      ul, ol { color: var(--kp-muted); padding-left: 1.25rem; margin-bottom: 0.75rem; }
      li { margin-bottom: 0.25rem; }
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
  const [cellContents, setCellContents] = useState<Record<string, CellContent>>({});

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

  // Start cell content generation
  const startCellContent = useCallback((cell: GridCell, topic: string) => {
    if (activeStreamsRef.current.has(cell.id)) return;
    activeStreamsRef.current.add(cell.id);

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    const params = new URLSearchParams({
      title: cell.title,
      description: cell.description,
      type: cell.type,
      size: cell.size,
      topic,
    });
    const streamUrl = `${apiUrl}/api/explore/content/${cell.id}?${params.toString()}`;

    setCellContents(prev => ({
      ...prev,
      [cell.id]: { html: '', isStreaming: true, isComplete: false }
    }));

    const eventSource = new EventSource(streamUrl);
    contentSourcesRef.current.set(cell.id, eventSource);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'content') {
          setCellContents(prev => ({
            ...prev,
            [cell.id]: { ...prev[cell.id], html: (prev[cell.id]?.html || '') + data.content }
          }));
        } else if (data.type === 'done') {
          setCellContents(prev => ({
            ...prev,
            [cell.id]: { ...prev[cell.id], isStreaming: false, isComplete: true }
          }));
          eventSource.close();
          contentSourcesRef.current.delete(cell.id);
        }
      } catch (e) { console.error('Parse error:', e); }
    };

    eventSource.onerror = () => {
      setCellContents(prev => ({ ...prev, [cell.id]: { ...prev[cell.id], isStreaming: false } }));
      eventSource.close();
      contentSourcesRef.current.delete(cell.id);
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
          const { layout: parsedLayout, closedCells } = parseLayoutXML(accumulatedXML);
          setLayout(parsedLayout);
          
          closedCells.forEach(cell => {
            if (!processedIds.has(cell.id)) {
              processedIds.add(cell.id);
              startCellContent(cell, decodeURIComponent(result).replace(/-/g, ' '));
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
  }, [result, startCellContent]);

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    clearUserLocalStorage();
    router.push('/auth');
  };

  const getInitials = (name: string) => name.split(' ').map(p => p.charAt(0)).join('').toUpperCase().substring(0, 2);

  if (!mounted) return <div className="min-h-screen w-full bg-background" />;

  const cells = layout.cells || [];
  const toc = layout.toc || [];
  const infobox = layout.infobox || [];
  const isAnyStreaming = isPlanning || Object.values(cellContents).some(s => s.isStreaming);

  // Grid column class
  const getColSpan = (size: string) => {
    switch (size) {
      case 'full': return 'col-span-12';
      case 'half': return 'col-span-12 md:col-span-6';
      case 'third': return 'col-span-12 md:col-span-4';
      case 'quarter': return 'col-span-12 md:col-span-3';
      default: return 'col-span-12';
    }
  };

  return (
    <div className="min-h-screen w-full bg-background">
      {/* Background effects - matching explorer page */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-muted/30 via-transparent to-transparent dark:from-primary/5" />
        <div className="absolute top-0 left-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-[150px] -translate-x-1/2 -translate-y-1/2" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] bg-primary/5 rounded-full blur-[120px] translate-x-1/3 translate-y-1/3" />
      </div>

      {/* Header - matching explorer page */}
      <header className="sticky top-0 z-50 w-full bg-background/80 backdrop-blur-xl border-b border-border/40">
        <div className="flex items-center justify-between h-16 px-4 md:px-6 max-w-[1600px] mx-auto">
          <Link href="/explorer" className="flex items-center gap-3">
            <KortixLogo size={18} variant="logomark" />
            <span className="text-lg font-medium text-foreground">Explorer</span>
            <span className="text-sm text-muted-foreground">v0.2</span>
          </Link>

          <div className="flex-1 flex justify-center px-8 max-w-xl mx-auto">
            <Link
              href="/explorer"
              className={cn(
                "flex items-center gap-3 h-10 px-4 rounded-2xl w-full",
                "border bg-card hover:bg-accent/50 transition-colors"
              )}
            >
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

      {/* Main Layout with Sidebar */}
      <div className="max-w-[1600px] mx-auto flex relative">
        {/* Left Sidebar - TOC */}
        <aside className="hidden lg:block w-64 flex-shrink-0 border-r border-border/40">
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

            {/* TOC Title */}
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Contents
            </div>

            {/* TOC Entries */}
            {toc.length > 0 ? (
              <ul className="space-y-1">
                {toc.map((entry) => (
                  <li key={entry.id}>
                    <a
                      href={`#cell-${entry.id}`}
                      className="flex items-center gap-2 py-2 px-3 -mx-3 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    >
                      <span className="text-xs text-muted-foreground/50 w-4">{entry.id}</span>
                      <span className="truncate">{entry.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="space-y-2">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="h-8 bg-muted/30 rounded-lg animate-pulse" />
                ))}
              </div>
            )}

            {/* Infobox in sidebar */}
            {infobox.length > 0 && (
              <div className="mt-8 pt-6 border-t border-border/40">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">
                  Quick Facts
                </div>
                <div className="space-y-4">
                  {infobox.map((item, i) => (
                    <div key={i}>
                      <div className="text-xs text-muted-foreground mb-0.5">{item.label}</div>
                      <div className="text-sm text-foreground font-medium">{item.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0 p-6 md:p-8 lg:p-10">
          {/* Title Section */}
          <AnimatePresence mode="wait">
            <motion.header
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="mb-8"
            >
              <h1 className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tight text-foreground mb-2">
                {layout.title || displayTopic}
              </h1>
              {layout.subtitle && (
                <p className="text-lg text-muted-foreground">{layout.subtitle}</p>
              )}
            </motion.header>
          </AnimatePresence>

          {/* Intro Paragraph */}
          {layout.intro && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.1 }}
              className="mb-10 text-base text-muted-foreground leading-relaxed max-w-4xl"
            >
              {layout.intro}
            </motion.div>
          )}

          {/* Mobile TOC */}
          {toc.length > 0 && (
            <div className="lg:hidden mb-8 p-4 bg-card rounded-2xl border border-border/40">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Contents
              </div>
              <div className="flex flex-wrap gap-2">
                {toc.map((entry) => (
                  <a
                    key={entry.id}
                    href={`#cell-${entry.id}`}
                    className="text-sm px-3 py-1.5 bg-muted/50 rounded-lg border border-border/40 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {entry.title}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Grid Layout */}
          <div className="grid grid-cols-12 gap-4 md:gap-6">
            {cells.map((cell, i) => {
              const content = cellContents[cell.id];
              
              return (
                <motion.div
                  key={cell.id}
                  id={`cell-${cell.id}`}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.4 }}
                  className={cn(
                    getColSpan(cell.size),
                    "scroll-mt-24"
                  )}
                >
                  <div className={cn(
                    "h-full rounded-2xl border border-border/40 bg-card overflow-hidden",
                    "hover:border-border/60 hover:shadow-lg transition-all duration-200"
                  )}>
                    {/* Cell Header */}
                    <div className="flex items-center justify-between px-5 py-4 border-b border-border/30 bg-muted/20">
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground/50 font-mono">{cell.id}</span>
                        <h3 className="text-base font-semibold text-foreground">{cell.title}</h3>
                      </div>
                      <div className="flex items-center gap-2">
                        {content?.isStreaming && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
                        {content?.isComplete && <Zap className="w-4 h-4 text-emerald-500" />}
                      </div>
                    </div>

                    {/* Cell Content */}
                    <div className="p-5 min-h-[120px]">
                      {content?.html ? (
                        <CellRenderer html={content.html} isDark={isDark} />
                      ) : (
                        <div className="flex items-center justify-center h-full min-h-[100px]">
                          <div className="flex items-center gap-3 text-muted-foreground">
                            <Loader2 className="w-5 h-5 animate-spin" />
                            <span className="text-sm">Generating...</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>

          {/* Loading skeleton */}
          {isPlanning && cells.length === 0 && (
            <div className="grid grid-cols-12 gap-4 md:gap-6">
              <div className="col-span-12 h-40 bg-card rounded-2xl border border-border/40 animate-pulse" />
              <div className="col-span-6 h-48 bg-card rounded-2xl border border-border/40 animate-pulse" />
              <div className="col-span-6 h-48 bg-card rounded-2xl border border-border/40 animate-pulse" />
              <div className="col-span-4 h-32 bg-card rounded-2xl border border-border/40 animate-pulse" />
              <div className="col-span-4 h-32 bg-card rounded-2xl border border-border/40 animate-pulse" />
              <div className="col-span-4 h-32 bg-card rounded-2xl border border-border/40 animate-pulse" />
            </div>
          )}

          {/* Footer */}
          <motion.footer
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="mt-12 pt-6 border-t border-border/30"
          >
            <p className="text-xs text-muted-foreground">
              Generated by <span className="font-medium text-foreground">Explorer</span> · Parallel AI content generation
            </p>
          </motion.footer>
        </main>
      </div>
    </div>
  );
}
