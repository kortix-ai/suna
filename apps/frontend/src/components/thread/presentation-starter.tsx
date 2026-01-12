'use client';

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  Presentation,
  FileText,
  Link as LinkIcon,
  ArrowRight,
  X,
  ChevronLeft,
  Check,
  Loader2,
  Upload,
  Globe,
} from 'lucide-react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface SlideInfo {
  number: number;
  filename: string;
}

interface TemplateInfo {
  id: string;
  name: string;
  slide_count: number;
  slides: SlideInfo[];
}

// Presentation templates - synced with backend templates
const presentationTemplates = [
  { id: 'minimalist', name: 'Minimalist', image: '/images/presentation-templates/minimalist-min.png' },
  { id: 'minimalist_2', name: 'Minimalist 2', image: '/images/presentation-templates/minimalist_2-min.png' },
  { id: 'black_and_white_clean', name: 'Black & White', image: '/images/presentation-templates/black_and_white_clean-min.png' },
  { id: 'colorful', name: 'Colorful', image: '/images/presentation-templates/colorful-min.png' },
  { id: 'startup', name: 'Startup', image: '/images/presentation-templates/startup-min.png' },
  { id: 'elevator_pitch', name: 'Elevator Pitch', image: '/images/presentation-templates/elevator_pitch-min.png' },
  { id: 'portfolio', name: 'Portfolio', image: '/images/presentation-templates/portfolio-min.png' },
  { id: 'textbook', name: 'Textbook', image: '/images/presentation-templates/textbook-min.png' },
  { id: 'architect', name: 'Architect', image: '/images/presentation-templates/architect-min.png' },
  { id: 'hipster', name: 'Hipster', image: '/images/presentation-templates/hipster-min.png' },
  { id: 'green', name: 'Green', image: '/images/presentation-templates/green-min.png' },
  { id: 'premium_black', name: 'Premium Black', image: '/images/presentation-templates/premium_black-min.png' },
  { id: 'premium_green', name: 'Premium Green', image: '/images/presentation-templates/premium_green-min.png' },
  { id: 'professor_gray', name: 'Professor Gray', image: '/images/presentation-templates/professor_gray-min.png' },
  { id: 'gamer_gray', name: 'Gamer Gray', image: '/images/presentation-templates/gamer_gray-min.png' },
  { id: 'competitor_analysis_blue', name: 'Analysis Blue', image: '/images/presentation-templates/competitor_analysis_blue-min.png' },
  { id: 'numbers_clean', name: 'Numbers Clean', image: '/images/presentation-templates/numbers_clean-min.png' },
  { id: 'numbers_colorful', name: 'Numbers Colorful', image: '/images/presentation-templates/numbers_colorful-min.png' },
];

// Creation methods - Kortix Brand colors (monochromatic, subtle)
const creationMethods = [
  {
    id: 'prompt',
    label: 'From Prompt',
    description: 'Generate slides from text',
    icon: <Presentation className="w-6 h-6" />,
    bgColor: 'bg-muted/50 dark:bg-muted/30',
    borderColor: 'border-border/80 dark:border-border/50',
    hoverBg: 'hover:bg-accent dark:hover:bg-accent/50',
  },
  {
    id: 'pdf',
    label: 'From File',
    description: 'Convert files to slides',
    icon: <FileText className="w-6 h-6" />,
    bgColor: 'bg-muted/50 dark:bg-muted/30',
    borderColor: 'border-border/80 dark:border-border/50',
    hoverBg: 'hover:bg-accent dark:hover:bg-accent/50',
  },
  {
    id: 'link',
    label: 'From URL',
    description: 'Generate slides from URL',
    icon: <LinkIcon className="w-6 h-6" />,
    bgColor: 'bg-muted/50 dark:bg-muted/30',
    borderColor: 'border-border/80 dark:border-border/50',
    hoverBg: 'hover:bg-accent dark:hover:bg-accent/50',
  },
];

// Silver shine spotlight effect for cards
interface SpotlightCardProps {
  children: React.ReactNode;
  className?: string;
}

function SpotlightCard({ children, className }: SpotlightCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setMousePosition({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  return (
    <div
      ref={ref}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn('relative overflow-hidden', className)}
      style={{
        // @ts-expect-error - CSS custom properties
        '--mouse-x': `${mousePosition.x}px`,
        '--mouse-y': `${mousePosition.y}px`,
      }}
    >
      {isHovered && (
        <div
          className="pointer-events-none absolute inset-0 transition-opacity duration-300 z-10 bg-[radial-gradient(200px_circle_at_var(--mouse-x)_var(--mouse-y),rgba(0,0,0,0.06),transparent_50%)] dark:bg-[radial-gradient(200px_circle_at_var(--mouse-x)_var(--mouse-y),rgba(255,255,255,0.12),transparent_50%)]"
          style={{ opacity: isHovered ? 1 : 0 }}
        />
      )}
      {children}
    </div>
  );
}

// Template slide preview component - mimics PresentationSlideCard iframe approach
interface TemplateSlidePreviewProps {
  slideNumber: number;
  templateId: string;
  templateName: string;
  backendUrl: string;
  animationDelay?: number;
}

function TemplateSlidePreview({
  slideNumber,
  templateId,
  templateName,
  backendUrl,
  animationDelay = 0,
}: TemplateSlidePreviewProps) {
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (!containerRef) return;

    const updateScale = () => {
      const containerWidth = containerRef.offsetWidth;
      const containerHeight = containerRef.offsetHeight;
      
      // Calculate scale to fit 1920x1080 into container while maintaining aspect ratio
      const scaleX = containerWidth / 1920;
      const scaleY = containerHeight / 1080;
      const newScale = Math.min(scaleX, scaleY);
      
      if (Math.abs(newScale - scale) > 0.001) {
        setScale(newScale);
      }
    };

    updateScale();

    const resizeObserver = new ResizeObserver(() => {
      updateScale();
    });
    resizeObserver.observe(containerRef);

    return () => {
      resizeObserver.disconnect();
    };
  }, [containerRef, scale]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: animationDelay, duration: 0.15 }}
      className="relative bg-background border border-border/50 rounded-xl overflow-hidden shadow-sm"
    >
      {/* Slide header */}
      <div className="px-3 py-2 bg-muted/20 border-b border-border/40 flex items-center">
        <span className="text-xs font-mono text-muted-foreground">
          Slide {slideNumber}
        </span>
      </div>
      
      {/* Slide Preview - aspect-video container */}
      <div className="relative aspect-video bg-muted/30">
        <div 
          ref={setContainerRef}
          className="w-full h-full bg-white overflow-hidden"
          style={{
            containIntrinsicSize: '1920px 1080px',
            contain: 'layout style'
          }}
        >
          <iframe
            src={`${backendUrl}/presentation-templates/${templateId}/slides/${slideNumber}`}
            title={`${templateName} - Slide ${slideNumber}`}
            className="border-0"
            sandbox="allow-same-origin"
            style={{
              width: '1920px',
              height: '1080px',
              border: 'none',
              display: 'block',
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
              position: 'absolute',
              top: 0,
              left: 0,
              pointerEvents: 'none',
            }}
          />
        </div>
      </div>
    </motion.div>
  );
}

interface PresentationStarterProps {
  onSelectMethod: (method: 'prompt' | 'pdf' | 'link', template?: string, data?: { url?: string; file?: File }) => void;
  onSelectTemplate: (templateId: string) => void;
  onClose?: () => void;
  className?: string;
}

export function PresentationStarter({
  onSelectMethod,
  onSelectTemplate,
  onClose,
  className,
}: PresentationStarterProps) {
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<typeof presentationTemplates[0] | null>(null);
  const [templateInfo, setTemplateInfo] = useState<TemplateInfo | null>(null);
  const [isLoadingInfo, setIsLoadingInfo] = useState(false);
  
  // Dialog states for URL and PDF
  const [activeDialog, setActiveDialog] = useState<'url' | 'pdf' | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || '';

  // Fetch template info when preview opens
  useEffect(() => {
    if (!previewTemplate) {
      setTemplateInfo(null);
      return;
    }

    const fetchTemplateInfo = async () => {
      setIsLoadingInfo(true);
      try {
        const response = await fetch(`${backendUrl}/presentation-templates/${previewTemplate.id}/info`);
        if (response.ok) {
          const data = await response.json();
          console.log('[PresentationStarter] Template info loaded:', data);
          setTemplateInfo(data);
        }
      } catch (error) {
        console.error('[PresentationStarter] Failed to load template info:', error);
      } finally {
        setIsLoadingInfo(false);
      }
    };

    fetchTemplateInfo();
  }, [previewTemplate, backendUrl]);

  const handleMethodClick = (methodId: 'prompt' | 'pdf' | 'link') => {
    console.log('[PresentationStarter] Method selected:', methodId, 'Template:', selectedTemplate);
    
    // For PDF and URL, show the dialog first
    if (methodId === 'pdf') {
      setActiveDialog('pdf');
      return;
    }
    if (methodId === 'link') {
      setActiveDialog('url');
      return;
    }
    
    // For prompt, proceed directly
    onSelectMethod(methodId, selectedTemplate ?? undefined);
  };

  const handleUrlSubmit = () => {
    if (!urlInput.trim()) return;
    console.log('[PresentationStarter] URL submitted:', urlInput);
    // Pass the URL as data - the parent will handle building the prompt
    onSelectMethod('link', selectedTemplate ?? undefined, { url: urlInput.trim() });
    setActiveDialog(null);
    setUrlInput('');
  };

  const handlePdfSubmit = () => {
    if (!pdfFile) return;
    console.log('[PresentationStarter] PDF submitted:', pdfFile.name);
    // Pass PDF file as data - the parent will handle the file upload
    onSelectMethod('pdf', selectedTemplate ?? undefined, { file: pdfFile });
    setActiveDialog(null);
    setPdfFile(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setPdfFile(file);
    }
  };

  const handleCloseDialog = () => {
    setActiveDialog(null);
    setUrlInput('');
    setPdfFile(null);
  };

  const handleTemplateClick = (template: typeof presentationTemplates[0]) => {
    console.log('[PresentationStarter] Template preview:', template.id);
    setPreviewTemplate(template);
  };

  const handleSelectTemplate = () => {
    if (previewTemplate) {
      console.log('[PresentationStarter] Template selected:', previewTemplate.id);
      setSelectedTemplate(previewTemplate.id);
      onSelectTemplate(previewTemplate.id);
      setPreviewTemplate(null);
    }
  };

  const handleClosePreview = () => {
    setPreviewTemplate(null);
  };

  return (
    <div className={cn(
      'relative flex flex-col h-full min-h-0 bg-card/95 dark:bg-card/90 backdrop-blur-sm rounded-2xl overflow-hidden border border-border/50',
      className
    )}>
      {/* URL Dialog Overlay */}
      <AnimatePresence>
        {activeDialog === 'url' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 z-50 flex flex-col bg-card/98 dark:bg-card/95 backdrop-blur-md rounded-2xl overflow-hidden"
          >
            {/* Dialog Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-border/50">
              <button
                onClick={handleCloseDialog}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </button>
              <span className="text-sm font-medium text-foreground">
                Create from URL
              </span>
              <div className="w-16" /> {/* Spacer for centering */}
            </div>

            {/* Dialog Content */}
            <div className="flex-1 flex flex-col items-center justify-center p-8">
              <div className="w-full max-w-md space-y-6">
                <div className="flex flex-col items-center text-center mb-8">
                  <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                    <Globe className="w-8 h-8 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">
                    Enter a URL
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    We'll extract the content and generate slides from it
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="url-input" className="text-sm text-muted-foreground">
                    Website URL
                  </Label>
                  <Input
                    id="url-input"
                    type="url"
                    placeholder="https://example.com/article"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
                    className="h-12 text-base"
                    autoFocus
                  />
                </div>

                <Button
                  onClick={handleUrlSubmit}
                  disabled={!urlInput.trim()}
                  className="w-full h-12 gap-2"
                  size="lg"
                >
                  <Presentation className="w-4 h-4" />
                  Generate Slides
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* PDF Dialog Overlay */}
      <AnimatePresence>
        {activeDialog === 'pdf' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 z-50 flex flex-col bg-card/98 dark:bg-card/95 backdrop-blur-md rounded-2xl overflow-hidden"
          >
            {/* Dialog Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-border/50">
              <button
                onClick={handleCloseDialog}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </button>
              <span className="text-sm font-medium text-foreground">
                Create from File
              </span>
              <div className="w-16" /> {/* Spacer for centering */}
            </div>

            {/* Dialog Content */}
            <div className="flex-1 flex flex-col items-center justify-center p-8">
              <div className="w-full max-w-md space-y-6">
                <div className="flex flex-col items-center text-center mb-8">
                  <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                    <Upload className="w-8 h-8 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">
                    Upload Files
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    We'll convert your files into editable slides
                  </p>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf,.pptx,.ppt,.doc,.docx,.txt,.md"
                  onChange={handleFileChange}
                  className="hidden"
                />

                <button
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    'w-full p-8 rounded-xl border-2 border-dashed transition-all duration-200',
                    'flex flex-col items-center justify-center gap-3',
                    'hover:border-foreground/30 hover:bg-accent/50',
                    pdfFile
                      ? 'border-primary bg-primary/5'
                      : 'border-border/80 bg-muted/30'
                  )}
                >
                  {pdfFile ? (
                    <>
                      <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                        <Check className="w-6 h-6 text-primary" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-medium text-foreground">{pdfFile.name}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {(pdfFile.size / 1024 / 1024).toFixed(2)} MB
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="w-12 h-12 rounded-xl bg-muted/50 flex items-center justify-center">
                        <Upload className="w-6 h-6 text-muted-foreground" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-medium text-foreground">Click to upload files</p>
                        <p className="text-xs text-muted-foreground mt-1">or drag and drop</p>
                      </div>
                    </>
                  )}
                </button>

                <Button
                  onClick={handlePdfSubmit}
                  disabled={!pdfFile}
                  className="w-full h-12 gap-2"
                  size="lg"
                >
                  <Presentation className="w-4 h-4" />
                  Convert to Slides
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Template Preview Overlay */}
      <AnimatePresence>
        {previewTemplate && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 z-50 flex flex-col bg-card/98 dark:bg-card/95 backdrop-blur-md rounded-2xl overflow-hidden"
          >
            {/* Preview Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-border/50">
              <button
                onClick={handleClosePreview}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </button>
              <span className="text-sm font-medium text-foreground">
                {previewTemplate.name}
                {templateInfo && (
                  <span className="text-muted-foreground ml-2">
                    ({templateInfo.slide_count} slides)
                  </span>
                )}
              </span>
              <Button
                onClick={handleSelectTemplate}
                size="sm"
                className="gap-2"
              >
                <Check className="w-4 h-4" />
                Use Template
              </Button>
            </div>

            {/* All Slides - Vertical Stack */}
            <ScrollArea className="flex-1 min-h-0">
              <div className="p-4 space-y-4">
                {isLoadingInfo ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Loading slides...</span>
                  </div>
                ) : templateInfo ? (
                  templateInfo.slides.map((slide, index) => (
                    <TemplateSlidePreview
                      key={slide.number}
                      slideNumber={slide.number}
                      templateId={previewTemplate.id}
                      templateName={previewTemplate.name}
                      backendUrl={backendUrl}
                      animationDelay={index * 0.03}
                    />
                  ))
                ) : (
                  // Fallback to PDF
                  <div className="w-full aspect-video rounded-lg overflow-hidden border border-border/50 shadow-sm">
                    <iframe
                      src={`${backendUrl}/presentation-templates/${previewTemplate.id}/pdf#toolbar=0&navpanes=0&view=FitH`}
                      className="w-full h-full border-0"
                      title={`${previewTemplate.name} Preview`}
                    />
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* Use Template Footer */}
            <div className="px-5 py-4 border-t border-border/50 bg-card/80">
              <Button
                onClick={handleSelectTemplate}
                className="w-full gap-2"
                size="lg"
              >
                <Check className="w-4 h-4" />
                Use This Template
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
            <Presentation className="w-4 h-4 text-primary" />
          </div>
          <h2 className="text-base font-semibold text-foreground">Create AI Slides</h2>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0" style={{ scrollBehavior: 'smooth' }}>
        <div className="p-5 space-y-6 pb-8">
          {/* Creation Methods */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">
              Select a slide creation method
            </h3>
            <div className="grid grid-cols-3 gap-3">
              {creationMethods.map((method, index) => (
                <motion.div
                  key={method.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05, duration: 0.2 }}
                >
                  <SpotlightCard className="rounded-xl">
                    <button
                      onClick={() => handleMethodClick(method.id as 'prompt' | 'pdf' | 'link')}
                      className={cn(
                        'w-full p-4 rounded-xl border transition-all duration-200 cursor-pointer',
                        'flex flex-col items-center text-center',
                        method.bgColor,
                        method.borderColor,
                        method.hoverBg,
                        'group hover:border-foreground/20 hover:shadow-sm'
                      )}
                    >
                      <div className="mb-2 text-muted-foreground group-hover:text-foreground group-hover:scale-110 transition-all">
                        {method.icon}
                      </div>
                      <span className="text-sm font-medium text-foreground mb-0.5 flex items-center gap-1.5">
                        {method.label}
                        <ArrowRight className="w-3.5 h-3.5 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {method.description}
                      </span>
                    </button>
                  </SpotlightCard>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Template Gallery */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">
              Quick start with a template
            </h3>
            <div className="grid grid-cols-3 gap-3">
              {presentationTemplates.map((template, index) => (
                <motion.div
                  key={template.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.15 + index * 0.02, duration: 0.2 }}
                >
                  <SpotlightCard className="rounded-xl">
                    <button
                      onClick={() => handleTemplateClick(template)}
                      className={cn(
                        'relative w-full aspect-[16/10] rounded-xl overflow-hidden cursor-pointer',
                        'border-2 transition-all duration-200',
                        'hover:shadow-lg hover:scale-[1.02]',
                        selectedTemplate === template.id
                          ? 'border-primary ring-2 ring-primary/20'
                          : 'border-border/50 hover:border-border'
                      )}
                    >
                      <Image
                        src={template.image}
                        alt={template.name}
                        fill
                        className="object-cover"
                        sizes="(max-width: 768px) 33vw, 200px"
                      />
                      {/* Overlay with name on hover */}
                      <div className={cn(
                        'absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent',
                        'flex items-end justify-center pb-2',
                        'opacity-0 hover:opacity-100 transition-opacity'
                      )}>
                        <span className="text-xs font-medium text-white">
                          {template.name}
                        </span>
                      </div>
                      {/* Selected indicator */}
                      {selectedTemplate === template.id && (
                        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                          <Check className="w-3 h-3 text-primary-foreground" />
                        </div>
                      )}
                    </button>
                  </SpotlightCard>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Instructions */}
          <div className="bg-accent/30 rounded-xl p-4">
            <h4 className="text-sm font-medium text-foreground mb-2">How it works</h4>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="text-foreground/60 mt-0.5">•</span>
                Pick a template or start from scratch
              </li>
              <li className="flex items-start gap-2">
                <span className="text-foreground/60 mt-0.5">•</span>
                Describe what you want in your slides
              </li>
              <li className="flex items-start gap-2">
                <span className="text-foreground/60 mt-0.5">•</span>
                AI generates your presentation instantly
              </li>
              <li className="flex items-start gap-2">
                <span className="text-foreground/60 mt-0.5">•</span>
                Edit, refine, and export to PPTX
              </li>
            </ul>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
