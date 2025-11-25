import React, { useState, useEffect } from 'react';
import { PresentationSlideCard } from './PresentationSlideCard';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import { Project } from '@/lib/api/threads';
import { Loader2 } from 'lucide-react';
import { usePresentationViewerStore } from '@/stores/presentation-viewer-store';

interface PresentationSlidePreviewProps {
  presentationName: string;
  project?: Project;
  onFullScreenClick?: (slideNumber: number) => void;
  className?: string;
  initialSlide?: number; // Optional slide number to show (defaults to first slide)
}

interface SlideMetadata {
  title: string;
  filename: string;
  file_path: string;
  preview_url: string;
  created_at: string;
}

interface PresentationMetadata {
  presentation_name: string;
  title: string;
  description: string;
  slides: Record<string, SlideMetadata>;
  created_at: string;
  updated_at: string;
}

const sanitizeFilename = (name: string): string => {
  return name.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
};

export function PresentationSlidePreview({
  presentationName,
  project,
  onFullScreenClick,
  className = '',
  initialSlide,
}: PresentationSlidePreviewProps) {
  const { openPresentation } = usePresentationViewerStore();
  const [metadata, setMetadata] = useState<PresentationMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadMetadata = async () => {
      if (!presentationName || !project?.sandbox?.sandbox_url) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const sanitizedName = sanitizeFilename(presentationName);
        const metadataUrl = constructHtmlPreviewUrl(
          project.sandbox.sandbox_url,
          `presentations/${sanitizedName}/metadata.json`
        );

        const urlWithCacheBust = `${metadataUrl}?t=${Date.now()}`;
        const response = await fetch(urlWithCacheBust, {
          cache: 'no-cache',
          headers: { 'Cache-Control': 'no-cache' },
        });

        if (response.ok) {
          const data = await response.json();
          setMetadata(data);
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      } catch (err) {
        console.error('Error loading presentation metadata:', err);
        setError(err instanceof Error ? err.message : 'Failed to load presentation');
      } finally {
        setIsLoading(false);
      }
    };

    loadMetadata();
  }, [presentationName, project?.sandbox?.sandbox_url]);

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center p-8 bg-muted/30 rounded-lg border ${className}`}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !metadata) {
    return null; // Fail silently in inline view
  }

  // Get slides and find the one to display
  const slides = Object.entries(metadata.slides)
    .map(([num, slide]) => ({ number: parseInt(num), ...slide }))
    .sort((a, b) => a.number - b.number);

  // Find the slide to display: use initialSlide if provided, otherwise use first slide
  const slideToDisplay = initialSlide 
    ? slides.find(slide => slide.number === initialSlide) || slides[0]
    : slides[0];

  if (!slideToDisplay) {
    return null;
  }

  const handleFullScreenClick = (slideNumber: number) => {
    if (onFullScreenClick) {
      onFullScreenClick(slideNumber);
    } else if (openPresentation && project?.sandbox?.sandbox_url) {
      // Open full screen presentation viewer directly using shared context
      openPresentation(presentationName, project.sandbox.sandbox_url, slideNumber);
    }
  };

  return (
    <PresentationSlideCard
      slide={slideToDisplay}
      project={project}
      onFullScreenClick={handleFullScreenClick}
      className={className}
      showFullScreenButton={true}
    />
  );
}

