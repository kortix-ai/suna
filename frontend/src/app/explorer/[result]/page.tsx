'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Zap, Loader2, X, ChevronLeft, ChevronRight } from 'lucide-react';
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
interface TocSection { id: string; title: string; }
interface GridCell {
  id: string;
  cols: string;
  type: string;
  tokens: string;
  title: string;
  description: string;
}

interface PageLayout {
  title: string;
  subtitle: string;
  toc: TocSection[];
  cells: GridCell[];
}

interface ContentState {
  html: string;
  isStreaming: boolean;
  isComplete: boolean;
}

// Parse XML
function parseLayoutXML(xml: string): { layout: Partial<PageLayout>; closedCells: GridCell[] } {
  const layout: Partial<PageLayout> = {};
  const closedCells: GridCell[] = [];

  const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/);
  if (titleMatch) layout.title = titleMatch[1].trim();
  
  const subtitleMatch = xml.match(/<subtitle>([\s\S]*?)<\/subtitle>/);
  if (subtitleMatch) layout.subtitle = subtitleMatch[1].trim();

  // Parse TOC
  const tocMatch = xml.match(/<toc>([\s\S]*?)<\/toc>/);
  if (tocMatch) {
    const sections: TocSection[] = [];
    const sectionRegex = /<section id="([^"]+)" title="([^"]+)"\s*\/>/g;
    let match;
    while ((match = sectionRegex.exec(tocMatch[1])) !== null) {
      sections.push({ id: match[1], title: match[2] });
    }
    layout.toc = sections;
  }

  // Parse cells
  const gridMatch = xml.match(/<grid>([\s\S]*)/);
  if (gridMatch) {
    const cellRegex = /<cell id="([^"]+)" cols="(\d+)" type="([^"]+)" tokens="(\d+)">([\s\S]*?)<\/cell>/g;
    let match;
    while ((match = cellRegex.exec(gridMatch[1])) !== null) {
      const cellContent = match[5];
      const titleMatch = cellContent.match(/<title>([\s\S]*?)<\/title>/);
      const descMatch = cellContent.match(/<desc>([\s\S]*?)<\/desc>/);
      
      closedCells.push({
        id: match[1],
        cols: match[2],
        type: match[3],
        tokens: match[4],
        title: titleMatch ? titleMatch[1].trim() : '',
        description: descMatch ? descMatch[1].trim() : ''
      });
    }
  }

  layout.cells = closedCells;
  return { layout, closedCells };
}

// Shadow DOM renderer
function ContentRenderer({ html, isDark }: { html: string; isDark: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRootRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (!shadowRootRef.current) {
      try { shadowRootRef.current = containerRef.current.attachShadow({ mode: 'open' }); }
      catch { return; }
    }

    const vars = isDark
      ? `--kp-text:#fafafa;--kp-muted:#a1a1aa;--kp-primary:#8b5cf6;--kp-card:#171717;--kp-border:#262626;`
      : `--kp-text:#171717;--kp-muted:#525252;--kp-primary:#7c3aed;--kp-card:#fafafa;--kp-border:#e5e5e5;`;

    shadowRootRef.current.innerHTML = `<style>
      :host{display:block;${vars}}
      *{margin:0;padding:0;box-sizing:border-box}
      .kp-cell{font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:var(--kp-text);font-size:14px;line-height:1.6}
      h2{font-size:1.2rem;font-weight:600;margin-bottom:0.75rem;color:var(--kp-text)}
      h3{font-size:1rem;font-weight:600;margin:1rem 0 0.5rem;color:var(--kp-text)}
      p{color:var(--kp-muted);margin-bottom:0.6rem;font-size:13px;line-height:1.65}
      ul,ol{color:var(--kp-muted);padding-left:1.25rem;font-size:13px;margin-bottom:0.6rem}
      li{margin-bottom:0.3rem}
      strong{color:var(--kp-text);font-weight:600}
      a{color:var(--kp-primary)}
    </style>${html || ''}`;
  }, [html, isDark]);

  return <div ref={containerRef} className="w-full h-full" />;
}

// Image Lightbox
function ImageLightbox({ images, currentIndex, onClose, onPrev, onNext }: { 
  images: string[]; currentIndex: number; onClose: () => void; onPrev: () => void; onNext: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') onPrev();
      if (e.key === 'ArrowRight') onNext();
    };
    window.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', handleKeyDown); document.body.style.overflow = ''; };
  }, [onClose, onPrev, onNext]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center" onClick={onClose}>
      <button onClick={onClose} className="absolute top-4 right-4 p-2 text-white/70 hover:text-white transition-colors z-10">
        <X className="w-6 h-6" />
      </button>
      {images.length > 1 && (
        <>
          <button onClick={(e) => { e.stopPropagation(); onPrev(); }} className="absolute left-4 p-3 text-white/70 hover:text-white bg-white/10 rounded-full transition-colors">
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onNext(); }} className="absolute right-4 p-3 text-white/70 hover:text-white bg-white/10 rounded-full transition-colors">
            <ChevronRight className="w-6 h-6" />
          </button>
        </>
      )}
      <motion.img key={currentIndex} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        src={images[currentIndex]} alt="" className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()} />
      <div className="absolute bottom-4 px-4 py-2 bg-black/50 rounded-full text-white/70 text-sm">
        {currentIndex + 1} / {images.length}
      </div>
    </motion.div>
  );
}

export default function ExplorerResultPage() {
  const params = useParams();
  const result = params.result as string;
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(true);

  const [isPlanning, setIsPlanning] = useState(true);
  const [layout, setLayout] = useState<Partial<PageLayout>>({});
  const [images, setImages] = useState<string[]>([]);
  const [imageCount, setImageCount] = useState(0);
  
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  
  const activeStreamsRef = useRef<Set<string>>(new Set());
  const plannerStartedRef = useRef(false);
  const [contentStates, setContentStates] = useState<Record<string, ContentState>>({});

  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const eventSourceRef = useRef<EventSource | null>(null);
  const contentSourcesRef = useRef<Map<string, EventSource>>(new Map());

  const displayTopic = useMemo(() => decodeURIComponent(result).replace(/-/g, ' '), [result]);

  useEffect(() => {
    const checkTheme = () => setIsDark(document.documentElement.classList.contains('dark'));
    checkTheme();
    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const startContentGeneration = useCallback((cell: GridCell, topic: string) => {
    if (activeStreamsRef.current.has(cell.id)) return;
    activeStreamsRef.current.add(cell.id);

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    const params = new URLSearchParams({
      title: cell.title, description: cell.description, type: cell.type, cols: cell.cols, tokens: cell.tokens, topic
    });

    setContentStates(prev => ({ ...prev, [cell.id]: { html: '', isStreaming: true, isComplete: false } }));

    const es = new EventSource(`${apiUrl}/v1/explore/content/${cell.id}?${params.toString()}`);
    contentSourcesRef.current.set(cell.id, es);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'content') {
          setContentStates(prev => ({ ...prev, [cell.id]: { ...prev[cell.id], html: (prev[cell.id]?.html || '') + data.content } }));
        } else if (data.type === 'done') {
          setContentStates(prev => ({ ...prev, [cell.id]: { ...prev[cell.id], isStreaming: false, isComplete: true } }));
          es.close();
          contentSourcesRef.current.delete(cell.id);
        }
      } catch (e) { console.error('Parse error:', e); }
    };

    es.onerror = () => {
      setContentStates(prev => ({ ...prev, [cell.id]: { ...prev[cell.id], isStreaming: false } }));
      es.close();
      contentSourcesRef.current.delete(cell.id);
    };
  }, []);

  useEffect(() => {
    setMounted(true);
    if (plannerStartedRef.current) return;
    plannerStartedRef.current = true;

    const processedIds = new Set<string>();
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

    const es = new EventSource(`${apiUrl}/v1/explore/${encodeURIComponent(result)}`);
    eventSourceRef.current = es;
    let accumulatedXML = '';

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'images') {
          setImages(data.images || []);
          setImageCount(data.count || data.images?.length || 0);
        } else if (data.type === 'content') {
          accumulatedXML += data.content;
          const { layout: parsedLayout, closedCells } = parseLayoutXML(accumulatedXML);
          setLayout(parsedLayout);
          
          closedCells.forEach(cell => {
            if (!processedIds.has(cell.id)) {
              processedIds.add(cell.id);
              startContentGeneration(cell, decodeURIComponent(result).replace(/-/g, ' '));
            }
          });
        } else if (data.type === 'done') {
          setIsPlanning(false);
          es.close();
        }
      } catch (e) { console.error('Parse error:', e); }
    };

    es.onerror = () => { setIsPlanning(false); es.close(); };

    return () => {
      eventSourceRef.current?.close();
      contentSourcesRef.current.forEach(s => s.close());
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

  const cells = layout.cells || [];
  const toc = layout.toc || [];
  const isAnyStreaming = isPlanning || Object.values(contentStates).some(s => s.isStreaming);
  const completedCount = Object.values(contentStates).filter(s => s.isComplete).length;

  const getColSpan = (cols: string) => {
    switch (cols) {
      case '1': return 'col-span-6 md:col-span-3';
      case '2': return 'col-span-12 md:col-span-6';
      case '3': return 'col-span-12 md:col-span-9';
      case '4': return 'col-span-12';
      default: return 'col-span-12 md:col-span-6';
    }
  };

  const getTypeStyle = (type: string) => {
    const styles: Record<string, { bg: string; border: string; badge: string }> = {
      stat: { bg: 'bg-emerald-500/5', border: 'border-emerald-500/20', badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
      fact: { bg: 'bg-blue-500/5', border: 'border-blue-500/20', badge: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
      component: { bg: 'bg-purple-500/5', border: 'border-purple-500/20', badge: 'bg-purple-500/10 text-purple-600 dark:text-purple-400' },
      section: { bg: 'bg-card', border: 'border-border/50', badge: 'bg-muted text-muted-foreground' },
      steps: { bg: 'bg-primary/5', border: 'border-primary/30', badge: 'bg-primary/10 text-primary' },
      timeline: { bg: 'bg-cyan-500/5', border: 'border-cyan-500/20', badge: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400' },
      pros: { bg: 'bg-green-500/5', border: 'border-green-500/20', badge: 'bg-green-500/10 text-green-600 dark:text-green-400' },
      cons: { bg: 'bg-red-500/5', border: 'border-red-500/20', badge: 'bg-red-500/10 text-red-600 dark:text-red-400' },
      resource: { bg: 'bg-orange-500/5', border: 'border-orange-500/20', badge: 'bg-orange-500/10 text-orange-600 dark:text-orange-400' },
    };
    return styles[type] || styles.section;
  };

  const isLargeCell = (type: string) => ['section', 'steps', 'timeline'].includes(type);

  return (
    <div className="min-h-screen w-full bg-background">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-muted/30 via-transparent to-transparent dark:from-primary/5" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-50 w-full bg-background/80 backdrop-blur-xl border-b border-border/40">
        <div className="flex items-center justify-between h-14 px-4 md:px-6 max-w-[1400px] mx-auto">
          <Link href="/explorer" className="flex items-center gap-2">
            <KortixLogo size={18} variant="logomark" />
            <span className="text-base font-medium text-foreground">Explorer</span>
          </Link>
          <div className="flex-1 flex justify-center px-4 max-w-md mx-auto">
            <Link href="/explorer" className="flex items-center gap-2 h-9 px-3 rounded-xl w-full border bg-card hover:bg-accent/50 transition-colors">
              <Search className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground flex-1">Search...</span>
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {user && !authLoading ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-8 w-8 rounded-full p-0">
                    <Avatar className="h-8 w-8">
                      <AvatarImage src={user.user_metadata?.avatar_url} />
                      <AvatarFallback className="text-xs">{getInitials(user.user_metadata?.full_name || user.email || 'U')}</AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem asChild><Link href="/dashboard">Dashboard</Link></DropdownMenuItem>
                  <DropdownMenuItem onClick={handleLogout}>Log out</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button asChild variant="ghost" size="sm"><Link href="/auth">Sign in</Link></Button>
            )}
          </div>
        </div>
      </header>

      {/* Main Layout */}
      <div className="max-w-[1400px] mx-auto flex">
        {/* Left Sidebar */}
        <aside className="hidden lg:block w-56 flex-shrink-0 border-r border-border/40">
          <div className="sticky top-14 p-4 max-h-[calc(100vh-56px)] overflow-y-auto">
            {/* Status */}
            <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border/40">
              {isAnyStreaming ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                  <span className="text-xs text-primary font-medium">{completedCount}/{cells.length || '...'}</span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">Complete</span>
                </div>
              )}
            </div>

            {/* TOC */}
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Contents</div>
            {toc.length > 0 ? (
              <nav className="space-y-0.5 mb-5">
                {toc.map((section, i) => (
                  <a key={section.id} href={`#cell-${section.id}`}
                    className="flex items-center gap-2 py-1.5 px-2 -mx-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors">
                    <span className="w-4 h-4 flex items-center justify-center text-[9px] font-medium bg-muted rounded">{i + 1}</span>
                    <span className="truncate">{section.title}</span>
                  </a>
                ))}
              </nav>
            ) : (
              <div className="space-y-1.5 mb-5">
                {[1,2,3,4,5].map(i => <div key={i} className="h-6 bg-muted/30 rounded animate-pulse" />)}
              </div>
            )}

            {/* Images */}
            {images.length > 0 && (
              <>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Images</div>
                  <span className="text-[10px] text-muted-foreground">{imageCount}</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {images.slice(0, 6).map((img, i) => (
                    <button key={i} onClick={() => { setLightboxIndex(i); setLightboxOpen(true); }}
                      className="aspect-square rounded-md overflow-hidden bg-muted/30 hover:ring-2 hover:ring-primary/50 transition-all group">
                      <img src={img} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform" loading="lazy"
                        onError={(e) => (e.currentTarget.parentElement!.style.display = 'none')} />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0 p-4 md:p-6">
          {/* Title */}
          <div className="mb-6">
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-foreground mb-1">{layout.title || displayTopic}</h1>
            {layout.subtitle && <p className="text-sm text-muted-foreground">{layout.subtitle}</p>}
          </div>

          {/* Mobile TOC */}
          <div className="lg:hidden mb-4 space-y-2">
            {images.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto pb-2">
                {images.slice(0, 5).map((img, i) => (
                  <button key={i} onClick={() => { setLightboxIndex(i); setLightboxOpen(true); }}
                    className="flex-shrink-0 w-12 h-12 rounded-md overflow-hidden bg-muted/30">
                    <img src={img} alt="" className="w-full h-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
            {toc.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {toc.map((section) => (
                  <a key={section.id} href={`#cell-${section.id}`}
                    className="px-2 py-0.5 text-[10px] bg-muted/50 hover:bg-muted rounded border border-border/40 text-muted-foreground">{section.title}</a>
                ))}
              </div>
            )}
          </div>

          {/* Content Grid - All cells flow top to bottom */}
          <div className="grid grid-cols-12 gap-3">
            {cells.map((cell, i) => {
              const state = contentStates[cell.id];
              const style = getTypeStyle(cell.type);
              const isLarge = isLargeCell(cell.type);
              
              return (
                <motion.div 
                  key={cell.id} 
                  id={`cell-${cell.id}`} 
                  initial={{ opacity: 0, y: 20 }} 
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.3 }}
                  className={cn(getColSpan(cell.cols), "scroll-mt-20")}
                >
                  <div className={cn(
                    "h-full rounded-xl border overflow-hidden transition-all duration-300",
                    style.bg, style.border,
                    state?.isStreaming && "ring-1 ring-primary/30",
                    !state?.html && "animate-pulse"
                  )}>
                    {/* Header */}
                    <div className="flex items-center justify-between px-3 py-2 border-b border-border/20 bg-background/30">
                      <h3 className={cn(
                        "font-medium text-foreground truncate pr-2",
                        isLarge ? "text-sm" : "text-xs"
                      )}>{cell.title}</h3>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className={cn("text-[8px] font-medium px-1.5 py-0.5 rounded uppercase", style.badge)}>{cell.type}</span>
                        {state?.isStreaming && <Loader2 className="w-3 h-3 animate-spin text-primary" />}
                        {state?.isComplete && <Zap className="w-3 h-3 text-emerald-500" />}
                      </div>
                    </div>
                    
                    {/* Content */}
                    <div className={cn(
                      "p-3 overflow-auto",
                      isLarge ? "min-h-[150px]" : "min-h-[80px]"
                    )}>
                      {state?.html ? (
                        <ContentRenderer html={state.html} isDark={isDark} />
                      ) : (
                        <div className="flex items-center justify-center h-full">
                          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/30" />
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>

          {/* Skeleton while planning */}
          {isPlanning && cells.length === 0 && (
            <div className="grid grid-cols-12 gap-3">
              {/* Stats row skeleton */}
              {[1, 2, 3, 4].map(i => (
                <div key={`stat-${i}`} className="col-span-6 md:col-span-3 h-24 bg-card rounded-xl border border-border/30 animate-pulse" />
              ))}
              {/* Section skeleton */}
              <div className="col-span-12 h-40 bg-card rounded-xl border border-border/30 animate-pulse" />
              {/* Two column skeleton */}
              <div className="col-span-12 md:col-span-6 h-32 bg-card rounded-xl border border-border/30 animate-pulse" />
              <div className="col-span-12 md:col-span-6 h-32 bg-card rounded-xl border border-border/30 animate-pulse" />
              {/* Full width skeleton */}
              <div className="col-span-12 h-48 bg-primary/5 rounded-xl border border-primary/20 animate-pulse" />
            </div>
          )}

          {/* Footer */}
          <div className="mt-8 pt-4 border-t border-border/30 text-center">
            <p className="text-[10px] text-muted-foreground">Generated by <span className="font-medium text-foreground">Explorer</span></p>
          </div>
        </main>
      </div>

      {/* Lightbox */}
      <AnimatePresence>
        {lightboxOpen && (
          <ImageLightbox images={images} currentIndex={lightboxIndex} onClose={() => setLightboxOpen(false)}
            onPrev={() => setLightboxIndex((p) => (p - 1 + images.length) % images.length)}
            onNext={() => setLightboxIndex((p) => (p + 1) % images.length)} />
        )}
      </AnimatePresence>
    </div>
  );
}
