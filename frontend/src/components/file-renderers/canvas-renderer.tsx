'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import Tesseract from 'tesseract.js';
import {
  Plus,
  Minus,
  MousePointer2,
  Hand,
  ImagePlus,
  Maximize,
  Save,
  Loader2,
  AlertCircle,
  Trash2,
  Copy,
  Download,
  Pencil,
  Sparkles,
  X,
  Type,
  Layers,
  ArrowLeftRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { useAuth } from '@/components/AuthProvider';

// OCR detected text region
interface TextRegion {
  id: string;
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

interface CanvasElement {
  id: string;
  type: 'image';
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
  locked: boolean;
  name: string;
}

interface CanvasData {
  name: string;
  version: string;
  background: string;
  elements: CanvasElement[];
  width?: number;
  height?: number;
}

interface CanvasRendererProps {
  content: string | null;
  filePath?: string;
  fileName: string;
  sandboxId?: string;
  className?: string;
  onSave?: (content: string) => Promise<void>;
}

function getSandboxFileUrl(sandboxId: string | undefined, path: string): string {
  if (!sandboxId) return path;
  let normalizedPath = path;
  if (normalizedPath.startsWith('/')) normalizedPath = normalizedPath.substring(1);
  if (normalizedPath.startsWith('workspace/')) normalizedPath = normalizedPath.substring(10);
  normalizedPath = `/workspace/${normalizedPath}`;
  const baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || '';
  return `${baseUrl}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(normalizedPath)}`;
}

// AI Processing Overlay with strong diagonal shimmer waves
function AIProcessingOverlay({ isVisible }: { isVisible: boolean }) {
  if (!isVisible) return null;
  
  return (
    <div className="absolute inset-0 overflow-hidden rounded pointer-events-none z-20">
      {/* Dim overlay to make shimmer more visible */}
      <div className="absolute inset-0 bg-black/30" />
      
      {/* Strong diagonal shimmer waves - slower animation */}
      <div 
        className="absolute inset-0"
        style={{
          background: `
            linear-gradient(
              110deg, 
              transparent 15%, 
              rgba(255,255,255,0.15) 25%,
              rgba(255,255,255,0.5) 45%,
              rgba(255,255,255,0.7) 50%,
              rgba(255,255,255,0.5) 55%,
              rgba(255,255,255,0.15) 75%,
              transparent 85%
            )
          `,
          backgroundSize: '300% 100%',
          animation: 'shimmer 2.5s infinite linear',
        }}
      />
      {/* Second wave for more intensity - slower */}
      <div 
        className="absolute inset-0"
        style={{
          background: `
            linear-gradient(
              110deg, 
              transparent 25%, 
              rgba(255,255,255,0.25) 40%,
              rgba(255,255,255,0.6) 50%,
              rgba(255,255,255,0.25) 60%,
              transparent 75%
            )
          `,
          backgroundSize: '250% 100%',
          animation: 'shimmer 2s infinite linear',
          animationDelay: '0.8s',
        }}
      />
      
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

// Image element with drag and resize
function CanvasImageElement({
  element,
  isSelected,
  onSelect,
  onChange,
  sandboxId,
  scale,
  stagePosition,
  authToken,
  isProcessing = false,
}: {
  element: CanvasElement;
  isSelected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onChange: (newAttrs: Partial<CanvasElement>) => void;
  sandboxId?: string;
  scale: number;
  stagePosition: { x: number; y: number };
  authToken?: string;
  isProcessing?: boolean;
}) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{
    type: 'move' | 'resize';
    handle?: string;
    startX: number;
    startY: number;
    startElemX: number;
    startElemY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);

  useEffect(() => {
    // For temp merge placeholders with no src, just show loading state
    if (!element.src) {
      setLoading(true);
      return;
    }
    if (element.src.startsWith('data:')) {
      setImageSrc(element.src);
      setLoading(false);
      return;
    }
    
    const loadImage = async () => {
      try {
        setLoading(true);
        setError(null);
        const url = sandboxId ? getSandboxFileUrl(sandboxId, element.src) : element.src;
        const headers: Record<string, string> = {};
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        const response = await fetch(url, { credentials: 'include', headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        setImageSrc(URL.createObjectURL(blob));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed');
      } finally {
        setLoading(false);
      }
    };
    loadImage();
  }, [element.src, sandboxId, authToken]);

  const posX = element.x * scale + stagePosition.x;
  const posY = element.y * scale + stagePosition.y;
  const width = element.width * scale;
  const height = element.height * scale;

  const handleMouseDown = (e: React.MouseEvent, type: 'move' | 'resize' = 'move', handle?: string) => {
    if (element.locked && type === 'move') return;
    e.stopPropagation();
    e.preventDefault();
    onSelect(e);
    setDragState({
      type,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startElemX: element.x,
      startElemY: element.y,
      startWidth: element.width,
      startHeight: element.height,
    });
  };

  useEffect(() => {
    if (!dragState) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - dragState.startX) / scale;
      const dy = (e.clientY - dragState.startY) / scale;

      if (dragState.type === 'move') {
        onChange({ x: dragState.startElemX + dx, y: dragState.startElemY + dy });
      } else if (dragState.type === 'resize' && dragState.handle) {
        const aspectRatio = dragState.startWidth / dragState.startHeight;
        let newX = dragState.startElemX;
        let newY = dragState.startElemY;
        let newW = dragState.startWidth;
        let newH = dragState.startHeight;

        // Corner handles - maintain aspect ratio
        if (dragState.handle === 'se') {
          // Use dominant axis
          if (Math.abs(dx) > Math.abs(dy)) {
            newW = Math.max(50, dragState.startWidth + dx);
            newH = newW / aspectRatio;
          } else {
            newH = Math.max(50, dragState.startHeight + dy);
            newW = newH * aspectRatio;
          }
        } else if (dragState.handle === 'sw') {
          if (Math.abs(dx) > Math.abs(dy)) {
            newW = Math.max(50, dragState.startWidth - dx);
            newH = newW / aspectRatio;
            newX = dragState.startElemX + (dragState.startWidth - newW);
          } else {
            newH = Math.max(50, dragState.startHeight + dy);
            newW = newH * aspectRatio;
            newX = dragState.startElemX + (dragState.startWidth - newW);
          }
        } else if (dragState.handle === 'ne') {
          if (Math.abs(dx) > Math.abs(dy)) {
            newW = Math.max(50, dragState.startWidth + dx);
            newH = newW / aspectRatio;
            newY = dragState.startElemY + (dragState.startHeight - newH);
          } else {
            newH = Math.max(50, dragState.startHeight - dy);
            newW = newH * aspectRatio;
            newY = dragState.startElemY + (dragState.startHeight - newH);
          }
        } else if (dragState.handle === 'nw') {
          if (Math.abs(dx) > Math.abs(dy)) {
            newW = Math.max(50, dragState.startWidth - dx);
            newH = newW / aspectRatio;
            newX = dragState.startElemX + (dragState.startWidth - newW);
            newY = dragState.startElemY + (dragState.startHeight - newH);
          } else {
            newH = Math.max(50, dragState.startHeight - dy);
            newW = newH * aspectRatio;
            newX = dragState.startElemX + (dragState.startWidth - newW);
            newY = dragState.startElemY + (dragState.startHeight - newH);
          }
        }
        // Edge handles - scale proportionally
        else if (dragState.handle === 'e') {
          newW = Math.max(50, dragState.startWidth + dx);
          newH = newW / aspectRatio;
          newY = dragState.startElemY + (dragState.startHeight - newH) / 2;
        } else if (dragState.handle === 'w') {
          newW = Math.max(50, dragState.startWidth - dx);
          newH = newW / aspectRatio;
          newX = dragState.startElemX + (dragState.startWidth - newW);
          newY = dragState.startElemY + (dragState.startHeight - newH) / 2;
        } else if (dragState.handle === 's') {
          newH = Math.max(50, dragState.startHeight + dy);
          newW = newH * aspectRatio;
          newX = dragState.startElemX + (dragState.startWidth - newW) / 2;
        } else if (dragState.handle === 'n') {
          newH = Math.max(50, dragState.startHeight - dy);
          newW = newH * aspectRatio;
          newX = dragState.startElemX + (dragState.startWidth - newW) / 2;
          newY = dragState.startElemY + (dragState.startHeight - newH);
        }

        onChange({ x: newX, y: newY, width: newW, height: newH });
      }
    };

    const handleMouseUp = () => setDragState(null);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState, scale, onChange]);

  if (loading || isProcessing) {
    return (
      <div 
        style={{ position: 'absolute', left: posX, top: posY, width, height }} 
        className="rounded overflow-hidden bg-card/50"
      >
        {/* Shimmer loading effect - no text */}
        <div className="relative w-full h-full">
          <div className="absolute inset-0 bg-black/30" />
          <div 
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.15) 50%, transparent 70%)',
              backgroundSize: '200% 100%',
              animation: 'shimmer 2s ease-in-out infinite',
            }}
          />
        </div>
        <style>{`
          @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
        `}</style>
      </div>
    );
  }

  if (error || !imageSrc) {
    return (
      <div style={{ position: 'absolute', left: posX, top: posY, width, height }} className="flex flex-col items-center justify-center bg-card/30 rounded border border-dashed border-border">
        <AlertCircle className="h-5 w-5 text-muted-foreground mb-1" />
        <span className="text-xs text-muted-foreground">Failed</span>
      </div>
    );
  }

  const isDragging = dragState?.type === 'move';
  const isResizing = dragState?.type === 'resize';

  return (
    <div
      onMouseDown={(e) => handleMouseDown(e, 'move')}
      style={{
        position: 'absolute',
        left: posX,
        top: posY,
        width,
        height,
        cursor: element.locked ? 'default' : isDragging ? 'grabbing' : 'grab',
        opacity: element.opacity || 1,
        transform: `rotate(${element.rotation || 0}deg)`,
        transformOrigin: 'center center',
      }}
    >
      <div className={cn("w-full h-full rounded overflow-hidden relative", isSelected && "ring-2 ring-blue-500")}>
        <img src={imageSrc} alt={element.name} draggable={false} className="w-full h-full object-contain pointer-events-none" />
        <AIProcessingOverlay isVisible={isProcessing} />
      </div>
      
      {isSelected && !element.locked && (
        <>
          {/* Corner handles - blue */}
          <div className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nwse-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'nw')} />
          <div className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nesw-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'ne')} />
          <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nesw-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'sw')} />
          <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nwse-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'se')} />
          {/* Edge handles - blue */}
          <div className="absolute top-1/2 -left-1.5 -translate-y-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ew-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'w')} />
          <div className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ew-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'e')} />
          <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ns-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'n')} />
          <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ns-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 's')} />
        </>
      )}
    </div>
  );
}

// Floating AI Toolbar Component
function FloatingToolbar({
  element,
  scale,
  stagePosition,
  onDuplicate,
  onDelete,
  onDownload,
  onImageUpdate,
  onProcessingChange,
  onTextEditStateChange,
  onTextRegionSelect,
  externalSelectedRegion,
  authToken,
  sandboxId,
}: {
  element: CanvasElement;
  scale: number;
  stagePosition: { x: number; y: number };
  onDuplicate: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onImageUpdate: (newSrc: string, newDimensions?: { width: number; height: number }) => void;
  onProcessingChange: (isProcessing: boolean) => void;
  onTextEditStateChange: (state: { regions: TextRegion[]; ocrImageSize: { width: number; height: number } } | null) => void;
  onTextRegionSelect?: (region: TextRegion) => void;
  externalSelectedRegion?: TextRegion | null;
  authToken?: string;
  sandboxId?: string;
}) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  
  // Text edit mode state
  const [textEditMode, setTextEditMode] = useState(false);
  const [isDetectingText, setIsDetectingText] = useState(false);
  const [detectedTextRegions, setDetectedTextRegions] = useState<TextRegion[]>([]);
  const [selectedTextRegion, setSelectedTextRegion] = useState<TextRegion | null>(null);
  const [newTextContent, setNewTextContent] = useState('');
  const [ocrImageSize, setOcrImageSize] = useState<{ width: number; height: number } | null>(null);
  const [showTextEditDialog, setShowTextEditDialog] = useState(false);

  // Sync with external selected region (from canvas-level clicks)
  useEffect(() => {
    if (externalSelectedRegion && externalSelectedRegion.id !== selectedTextRegion?.id) {
      setSelectedTextRegion(externalSelectedRegion);
      // Only pre-fill text if confidence is high enough (> 60), otherwise let user type
      const prefillText = externalSelectedRegion.confidence > 60 ? externalSelectedRegion.text : '';
      setNewTextContent(prefillText);
      setShowTextEditDialog(true);
    }
  }, [externalSelectedRegion]);

  // Run OCR to detect text regions using worker for full data
  const detectTextRegions = async () => {
    setIsDetectingText(true);
    onProcessingChange(true); // Show shimmer on image
    
    try {
      const imageBase64 = await getImageAsBase64(element.src);
      
      // Get actual image dimensions for proper bbox scaling
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = imageBase64;
      });
      const originalWidth = img.naturalWidth;
      const originalHeight = img.naturalHeight;
      // console.log('Original image size:', originalWidth, 'x', originalHeight);
      setOcrImageSize({ width: originalWidth, height: originalHeight });
      
      // Use createWorker and request detailed output
      const worker = await Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text') {
            console.log('[Tesseract] Progress:', Math.round((m.progress || 0) * 100) + '%');
          }
        },
      });
      
      // Set parameters for better text detection
      // PSM 11 = Sparse text - find as much text as possible in no particular order
      // PSM 6 = Assume a single uniform block of text
      await worker.setParameters({
        tessedit_pageseg_mode: '11', // Sparse text mode - better for signs/logos
      });
      
      // The 3rd param 'output' specifies what data to return!
      // recognize(image, options, output, jobId)
      const result = await (worker.recognize as (
        image: string,
        options?: object,
        output?: { blocks?: boolean; text?: boolean; hocr?: boolean; tsv?: boolean },
        jobId?: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) => Promise<any>)(imageBase64, {}, { 
        blocks: true, 
        text: true,
        hocr: true,
        tsv: true,
      });
      await worker.terminate();
      
      // Debug output check (disabled)
      // console.log('blocks:', result.data.blocks);
      // console.log('TSV:', result.data.tsv ? 'available' : 'null');
      
      // Parse TSV output which contains bounding boxes
      // TSV format: level, page_num, block_num, par_num, line_num, word_num, left, top, width, height, conf, text
      const tsv = result.data.tsv;
      const regions: TextRegion[] = [];
      
      if (tsv) {
        const tsvLines = tsv.split('\n');
        
        tsvLines.forEach((line, idx) => {
          if (idx === 0) return; // Skip header
          const parts = line.split('\t');
          if (parts.length >= 12) {
            const level = parseInt(parts[0]);
            const left = parseInt(parts[6]);
            const top = parseInt(parts[7]);
            const width = parseInt(parts[8]);
            const height = parseInt(parts[9]);
            const conf = parseFloat(parts[10]);
            const text = parts[11];
            
            // Level 5 = word level - include all with valid size
            if (level === 5 && text && text.trim().length > 0 && width > 0 && height > 0) {
              regions.push({
                id: `word-${regions.length}`,
                text: text.trim(),
                bbox: { x0: left, y0: top, x1: left + width, y1: top + height },
                confidence: conf,
              });
            }
          }
        });
      }
      
      // Debug: log if no regions found
      // if (regions.length === 0) console.log('No text regions detected');
      
      if (regions.length === 0) {
        const fullText = (result.data.text || '').trim();
        if (fullText.length > 0) {
          toast.warning('Text found but no bounding boxes. Check console for debug info.');
        } else {
          toast.warning('No text detected in this image');
        }
        setTextEditMode(false);
      } else {
        setDetectedTextRegions(regions);
        // Report to parent for canvas-level rendering
        onTextEditStateChange({ regions, ocrImageSize: { width: originalWidth, height: originalHeight } });
        toast.success(`Found ${regions.length} text region${regions.length > 1 ? 's' : ''}`);
      }
    } catch (err) {
      console.error('OCR error:', err);
      toast.error('Failed to detect text: ' + (err instanceof Error ? err.message : 'Unknown error'));
      setTextEditMode(false);
    } finally {
      setIsDetectingText(false);
      onProcessingChange(false); // Hide shimmer
    }
  };
  
  // Start text edit mode
  const startTextEditMode = () => {
    setTextEditMode(true);
    setDetectedTextRegions([]);
    setSelectedTextRegion(null);
    detectTextRegions();
  };
  
  // Cancel text edit mode
  const cancelTextEditMode = () => {
    setTextEditMode(false);
    setDetectedTextRegions([]);
    setSelectedTextRegion(null);
    setNewTextContent('');
    setShowTextEditDialog(false);
    onTextEditStateChange(null); // Clear parent state
  };
  
  // Handle text region click
  const handleTextRegionClick = (region: TextRegion) => {
    setSelectedTextRegion(region);
    // Only pre-fill text if confidence is high (> 60), otherwise let user type
    setNewTextContent(region.confidence > 60 ? region.text : '');
    setShowTextEditDialog(true);
    onTextRegionSelect?.(region);
  };
  
  // Apply text replacement
  const applyTextReplacement = async () => {
    if (!selectedTextRegion || !newTextContent.trim()) return;
    
    setShowTextEditDialog(false);
    
    // For low confidence OCR, describe the region location instead of using garbled text
    let prompt: string;
    if (selectedTextRegion.confidence > 60) {
      prompt = `Replace the text "${selectedTextRegion.text}" with "${newTextContent}" in this image. Keep the same font style, size, color, and position.`;
    } else {
      // Use bounding box description for low confidence
      const bbox = selectedTextRegion.bbox;
      const centerX = ((bbox.x0 + bbox.x1) / 2 / (ocrImageSize?.width || 1)) * 100;
      const centerY = ((bbox.y0 + bbox.y1) / 2 / (ocrImageSize?.height || 1)) * 100;
      const position = centerY < 33 ? 'top' : centerY > 66 ? 'bottom' : 'middle';
      const hPosition = centerX < 33 ? 'left' : centerX > 66 ? 'right' : 'center';
      prompt = `Replace the text in the ${position}-${hPosition} area of this image with "${newTextContent}". Keep the same font style, size, color, and background.`;
    }
    
    await handleAIAction('edit_text', prompt);
    cancelTextEditMode();
  };

  // Convert image URL/path to base64
  const getImageAsBase64 = async (src: string): Promise<string> => {
    // Already base64
    if (src.startsWith('data:')) {
      return src;
    }
    
    // Construct proper URL for sandbox files
    const url = sandboxId ? getSandboxFileUrl(sandboxId, src) : src;
    
    // Fetch the image and convert to base64
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      
      const response = await fetch(url, {
        headers,
        credentials: 'include',
      });
      
      if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
      
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      console.error('Failed to convert image to base64:', err);
      throw new Error('Could not load image for processing');
    }
  };

  const handleAIAction = async (action: 'upscale' | 'remove_bg' | 'edit_text' | 'mark_edit', prompt?: string) => {
    setIsProcessing(true);
    setActiveAction(action);
    onProcessingChange(true);
    
    const actionLabels: Record<string, string> = {
      upscale: 'Upscaling image...',
      remove_bg: 'Removing background...',
      edit_text: 'Editing text...',
      mark_edit: 'Applying edit...',
    };
    
    toast.info(actionLabels[action], { description: prompt || 'Processing with AI...' });
    
    try {
      // Get actual base64 data (fetch if needed)
      const imageBase64 = await getImageAsBase64(element.src);
      
      // Call backend Canvas AI API
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/canvas-ai/process`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          action,
          image_base64: imageBase64,
          prompt: prompt || undefined,
        }),
      });
      
      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || 'API request failed');
      }
      
      const result = await response.json();
      
      if (result.success && result.image_base64) {
        // For upscale, get the new image dimensions
        if (action === 'upscale') {
          // Load the image to get its actual dimensions
          const img = new Image();
          img.onload = () => {
            onImageUpdate(result.image_base64, { width: img.naturalWidth, height: img.naturalHeight });
            toast.success(`Upscaled to ${img.naturalWidth}×${img.naturalHeight}!`);
          };
          img.onerror = () => {
            // Fallback: just update src without dimensions
            onImageUpdate(result.image_base64);
            toast.success('Upscale completed!');
          };
          img.src = result.image_base64;
        } else {
          // Other actions: just update the src
          onImageUpdate(result.image_base64);
          toast.success(`${action.replace('_', ' ')} completed!`);
        }
      } else {
        toast.error(result.error || 'Processing failed', {
          description: result.message || 'Please try again'
        });
      }
      
    } catch (err) {
      console.error('AI action error:', err);
      toast.error('Failed to process image', {
        description: err instanceof Error ? err.message : 'Unknown error'
      });
    } finally {
      setIsProcessing(false);
      setActiveAction(null);
      setEditPrompt('');
      onProcessingChange(false);
    }
  };

  // When in text edit mode, show simplified toolbar
  if (textEditMode) {
    return (
      <div
        style={{
          position: 'absolute',
          left: element.x * scale + stagePosition.x + (element.width * scale) / 2,
          top: element.y * scale + stagePosition.y + element.height * scale + 8,
          transform: 'translateX(-50%)',
          zIndex: 100,
        }}
      >
        <div className="flex items-center gap-2 bg-card border border-border rounded-full px-3 py-1.5">
          <span className="text-xs text-muted-foreground">Click on text to edit</span>
          <Button 
            variant="ghost" 
            size="sm" 
            className="h-6 px-2 rounded-full text-xs"
            onClick={cancelTextEditMode}
          >
            <X className="h-3 w-3 mr-1" />
            Cancel
          </Button>
        </div>
        
        {/* Text edit dialog - keep it here */}
        <Dialog open={showTextEditDialog} onOpenChange={setShowTextEditDialog}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Replace text</DialogTitle>
              {selectedTextRegion && selectedTextRegion.confidence <= 60 && (
                <p className="text-sm text-muted-foreground">
                  Type what text you want in this area
                </p>
              )}
            </DialogHeader>
            <div className="space-y-4">
              <Textarea
                value={newTextContent}
                onChange={(e) => setNewTextContent(e.target.value)}
                placeholder={selectedTextRegion && selectedTextRegion.confidence <= 60 
                  ? "Type the new text you want here..." 
                  : "Enter replacement text..."}
                className="min-h-[100px]"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowTextEditDialog(false)}>
                  Cancel
                </Button>
                <Button onClick={applyTextReplacement} disabled={!newTextContent.trim() || isProcessing}>
                  {isProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Replace
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: element.x * scale + stagePosition.x + (element.width * scale) / 2,
        top: element.y * scale + stagePosition.y + element.height * scale + 8,
        transform: 'translateX(-50%)',
        zIndex: 100,
      }}
    >
      {/* File info - inline centered */}
      <div className="flex items-center justify-center gap-2 mb-1">
        <span className="text-xs text-muted-foreground truncate max-w-[150px]">{element.name}</span>
        <span className="text-xs text-muted-foreground">{Math.round(element.width)}×{Math.round(element.height)}</span>
      </div>
      
      {/* Main AI toolbar */}
      <div className="flex items-center gap-0.5 bg-card border border-border rounded-full px-1.5 py-1">
        <TooltipProvider delayDuration={0}>
          {/* Upscale */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button 
                variant="ghost" 
                size="sm" 
                className="h-7 px-2 rounded-full gap-1.5 text-xs"
                onClick={() => handleAIAction('upscale')}
                disabled={isProcessing}
              >
                {activeAction === 'upscale' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <span className="text-[10px] font-bold border border-current rounded px-0.5">HD</span>
                )}
                Upscale
              </Button>
            </TooltipTrigger>
            <TooltipContent>Upscale image with AI</TooltipContent>
          </Tooltip>

          {/* Remove Background */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button 
                variant="ghost" 
                size="sm" 
                className="h-7 px-2 rounded-full gap-1.5 text-xs"
                onClick={() => handleAIAction('remove_bg')}
                disabled={isProcessing}
              >
                {activeAction === 'remove_bg' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="1" y="1" width="6" height="6" />
                    <rect x="9" y="1" width="6" height="6" strokeDasharray="2 1" />
                    <rect x="1" y="9" width="6" height="6" strokeDasharray="2 1" />
                    <rect x="9" y="9" width="6" height="6" />
                  </svg>
                )}
                Remove bg
              </Button>
            </TooltipTrigger>
            <TooltipContent>Remove background with AI</TooltipContent>
          </Tooltip>

          {/* Edit Text - OCR-based selection */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button 
                variant="ghost" 
                size="sm" 
                className="h-7 px-2 rounded-full gap-1.5 text-xs"
                onClick={startTextEditMode}
                disabled={isProcessing || textEditMode}
              >
                {isDetectingText ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Type className="h-3.5 w-3.5" />}
                Edit text
              </Button>
            </TooltipTrigger>
            <TooltipContent>Select and edit text in image</TooltipContent>
          </Tooltip>

          {/* Mark Edit - with prompt input */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="h-7 px-2 rounded-full gap-1.5 text-xs"
                    disabled={isProcessing}
                  >
                    {activeAction === 'mark_edit' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="2" y="2" width="12" height="12" strokeDasharray="3 2" rx="1" />
                        <path d="M6 8L7.5 9.5L10 6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                    Mark edit
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>AI-powered image editing</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-72 p-3" align="center">
              <div className="space-y-2">
                <label className="text-xs font-medium">Describe the edit you want</label>
                <Input 
                  placeholder='e.g., "Make the sky sunset colors"'
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && editPrompt.trim()) {
                      handleAIAction('mark_edit', editPrompt);
                    }
                  }}
                />
                <Button 
                  size="sm" 
                  className="w-full"
                  onClick={() => handleAIAction('mark_edit', editPrompt)}
                  disabled={!editPrompt.trim() || isProcessing}
                >
                  {isProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                  Generate Edit
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <div className="w-px h-5 bg-border mx-0.5" />

          {/* Download - icon only */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={onDownload}>
                <Download className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download</TooltipContent>
          </Tooltip>

          {/* Copy - icon only */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={onDuplicate}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Duplicate</TooltipContent>
          </Tooltip>

          {/* Delete - icon only */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full text-destructive hover:text-destructive" onClick={onDelete}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

// Multi-select toolbar for merging multiple images
function MultiSelectToolbar({
  elements,
  scale,
  stagePosition,
  onStartMerge,
  onMergeComplete,
  onMergeFailed,
  onDelete,
  onProcessingChange,
  authToken,
  sandboxId,
}: {
  elements: CanvasElement[];
  scale: number;
  stagePosition: { x: number; y: number };
  onStartMerge: () => string; // Returns temp element ID
  onMergeComplete: (tempId: string, mergedImageSrc: string) => void;
  onMergeFailed: (tempId: string) => void;
  onDelete: () => void;
  onProcessingChange: (isProcessing: boolean) => void;
  authToken?: string;
  sandboxId?: string;
}) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [mergePrompt, setMergePrompt] = useState('');
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [imageOrder, setImageOrder] = useState<string[]>([]); // IDs in order
  
  // Initialize image order when dialog opens
  const openMergeDialog = () => {
    setImageOrder(elements.map(el => el.id));
    setShowMergeDialog(true);
  };
  
  // Get ordered elements based on current order
  const orderedElements = imageOrder.map(id => elements.find(el => el.id === id)).filter(Boolean) as CanvasElement[];
  
  // Swap two images in the order
  const swapImages = (idx1: number, idx2: number) => {
    setImageOrder(prev => {
      const newOrder = [...prev];
      [newOrder[idx1], newOrder[idx2]] = [newOrder[idx2], newOrder[idx1]];
      return newOrder;
    });
  };
  
  // Calculate center position of all selected elements
  const bounds = elements.reduce((acc, el) => ({
    minX: Math.min(acc.minX, el.x),
    minY: Math.min(acc.minY, el.y),
    maxX: Math.max(acc.maxX, el.x + el.width),
    maxY: Math.max(acc.maxY, el.y + el.height),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  
  const centerX = ((bounds.minX + bounds.maxX) / 2) * scale + stagePosition.x;
  const bottomY = bounds.maxY * scale + stagePosition.y + 8;

  // Convert image to base64
  const getImageAsBase64 = async (src: string): Promise<string> => {
    if (src.startsWith('data:')) return src;
    
    const url = sandboxId ? getSandboxFileUrl(sandboxId, src) : src;
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    
    const response = await fetch(url, { headers, credentials: 'include' });
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const handleMerge = async () => {
    if (!mergePrompt.trim() || elements.length < 2) return;
    
    setIsProcessing(true);
    onProcessingChange(true);
    
    // Create temporary placeholder element with shimmer
    const tempId = onStartMerge();
    
    toast.info('Merging images...', { description: mergePrompt });
    
    try {
      // Get all images as base64 in the user-specified order
      const imagesBase64 = await Promise.all(
        orderedElements.map(async (el) => ({
          id: el.id,
          base64: await getImageAsBase64(el.src),
          width: el.width,
          height: el.height,
        }))
      );
      
      // Send to backend - use correct backend URL
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';
      const response = await fetch(`${backendUrl}/canvas-ai/merge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          images: imagesBase64.map(img => img.base64),
          prompt: mergePrompt,
        }),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to merge images');
      }
      
      const result = await response.json();
      
      if (result.image) {
        toast.success('Images merged successfully!');
        onMergeComplete(tempId, result.image);
      } else {
        throw new Error('No image returned from merge');
      }
    } catch (err) {
      console.error('Merge error:', err);
      toast.error('Failed to merge images', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
      onMergeFailed(tempId);
    } finally {
      setIsProcessing(false);
      setMergePrompt('');
      onProcessingChange(false);
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: centerX,
        top: bottomY,
        transform: 'translateX(-50%)',
        zIndex: 100,
      }}
    >
      {/* Selection info */}
      <div className="flex items-center justify-center gap-2 mb-1">
        <span className="text-xs text-muted-foreground">{elements.length} images selected</span>
      </div>
      
      {/* Merge toolbar */}
      <div className="flex items-center gap-1 bg-card border border-border rounded-full px-2 py-1">
        <TooltipProvider delayDuration={0}>
          {/* Merge button - opens dialog */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button 
                variant="ghost" 
                size="sm" 
                className="h-7 px-2 rounded-full gap-1.5 text-xs"
                disabled={isProcessing}
                onClick={openMergeDialog}
              >
                {isProcessing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Layers className="h-3.5 w-3.5" />
                )}
                Merge
              </Button>
            </TooltipTrigger>
            <TooltipContent>Merge selected images with AI</TooltipContent>
          </Tooltip>

          {/* Separator */}
          <div className="w-px h-4 bg-border mx-1" />

          {/* Delete all */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-7 w-7 rounded-full text-destructive hover:text-destructive"
                onClick={onDelete}
                disabled={isProcessing}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete selected</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Merge Dialog */}
      <Dialog open={showMergeDialog} onOpenChange={setShowMergeDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Merge images</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Image order preview */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Image order (click arrows to swap)</label>
              <div className="flex items-center gap-2 overflow-x-auto py-2">
                {orderedElements.map((el, idx) => (
                  <div key={el.id} className="flex items-center gap-1">
                    <div className="relative group">
                      <div className="w-16 h-16 rounded border border-border overflow-hidden bg-card flex-shrink-0 relative">
                        {el.src?.startsWith('data:') ? (
                          <img 
                            src={el.src} 
                            alt={el.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center text-xs text-muted-foreground p-1">
                            <ImagePlus className="h-4 w-4 mb-0.5 opacity-50" />
                            <span className="truncate w-full text-center text-[9px]">{el.name?.split('/').pop() || `Image ${idx + 1}`}</span>
                          </div>
                        )}
                      </div>
                      <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-[10px] px-1.5 rounded-full">
                        {idx + 1}
                      </div>
                    </div>
                    {idx < orderedElements.length - 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 flex-shrink-0"
                        onClick={() => swapImages(idx, idx + 1)}
                        title="Swap with next"
                      >
                        <ArrowLeftRight className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            
            {/* Merge prompt */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">How should these images be merged?</label>
              <Textarea
                value={mergePrompt}
                onChange={(e) => setMergePrompt(e.target.value)}
                placeholder='e.g. "Blend seamlessly", "Create a collage", "Overlay second on first"'
                className="min-h-[80px]"
                autoFocus
              />
            </div>
            
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setShowMergeDialog(false); setMergePrompt(''); }}>
                Cancel
              </Button>
              <Button 
                onClick={() => { setShowMergeDialog(false); handleMerge(); }} 
                disabled={!mergePrompt.trim() || isProcessing}
              >
                {isProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function CanvasRenderer({ content, filePath, fileName, sandboxId, className, onSave }: CanvasRendererProps) {
  const { session } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [processingElementId, setProcessingElementId] = useState<string | null>(null);
  
  // Text edit mode state - managed at canvas level for proper positioning
  const [textEditState, setTextEditState] = useState<{
    elementId: string;
    regions: TextRegion[];
    ocrImageSize: { width: number; height: number };
  } | null>(null);
  const [selectedTextRegion, setSelectedTextRegion] = useState<TextRegion | null>(null);
  const [canvasData, setCanvasData] = useState<CanvasData | null>(null);
  const [scale, setScale] = useState(1);
  const [stagePosition, setStagePosition] = useState({ x: 50, y: 50 });
  const [toolMode, setToolMode] = useState<'select' | 'pan'>('select');
  const [isPanning, setIsPanning] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [selectionRect, setSelectionRect] = useState<{ startX: number; startY: number; x: number; y: number; w: number; h: number } | null>(null);
  const panStartRef = useRef<{ x: number; y: number; stageX: number; stageY: number } | null>(null);
  const selectionStartRef = useRef<{ x: number; y: number } | null>(null);
  const hasCenteredRef = useRef(false);
  
  const authToken = session?.access_token;

  useEffect(() => {
    if (content) {
      try {
        const parsed: CanvasData = JSON.parse(content);
        setCanvasData(parsed);
        setElements(parsed.elements || []);
        hasCenteredRef.current = false; // Reset so centering happens for new content
      } catch (e) {
        console.error('[CanvasRenderer] Parse error:', e);
      }
    }
  }, [content]);

  useEffect(() => { setIsMounted(true); }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const updateSize = () => {
      if (containerRef.current) {
        setContainerSize({ width: containerRef.current.offsetWidth, height: containerRef.current.offsetHeight });
      }
    };
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);
    updateSize();
    return () => observer.disconnect();
  }, []);

  // Center canvas ONCE on initial load only
  useEffect(() => {
    if (hasCenteredRef.current) return; // Already centered, don't run again
    if (elements.length === 0 || containerSize.width === 0 || containerSize.height === 0) return;
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    elements.forEach(el => {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + el.width);
      maxY = Math.max(maxY, el.y + el.height);
    });
    
    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const contentCenterX = minX + contentWidth / 2;
    const contentCenterY = minY + contentHeight / 2;
    
    // Position so content is centered in the container
    const newX = (containerSize.width / 2) - (contentCenterX * scale);
    const newY = (containerSize.height / 2) - (contentCenterY * scale);
    
    setStagePosition({ x: newX, y: newY });
    hasCenteredRef.current = true;
  }, [elements, containerSize.width, containerSize.height, scale]);

  const handleZoomIn = () => setScale(s => Math.min(s * 1.15, 5));
  const handleZoomOut = () => setScale(s => Math.max(s / 1.15, 0.1));
  const handleResetView = () => { setScale(1); hasCenteredRef.current = false; };

  // Store current scale and position in refs for wheel handler (to avoid stale closures)
  const scaleRef = useRef(scale);
  const stagePositionRef = useRef(stagePosition);
  
  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { stagePositionRef.current = stagePosition; }, [stagePosition]);
  
  // Attach wheel listener with passive: false
  useEffect(() => {
    if (!isMounted) return;
    
    // Use requestAnimationFrame to ensure DOM is ready
    const rafId = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) {
        console.warn('Canvas container not found for wheel handler');
        return;
      }
      
      const handler = (e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Pinch-to-zoom on trackpad (ctrlKey is true for pinch gestures)
        if (e.ctrlKey || e.metaKey) {
          // ZOOM mode - zoom towards cursor
          const rect = container.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;
          
          const currentScale = scaleRef.current;
          const currentPos = stagePositionRef.current;
          
          const zoomSensitivity = 0.01;
          const zoomFactor = 1 - e.deltaY * zoomSensitivity;
          const newScale = Math.max(0.1, Math.min(5, currentScale * zoomFactor));
          
          const scaleRatio = newScale / currentScale;
          const newPosX = mouseX - (mouseX - currentPos.x) * scaleRatio;
          const newPosY = mouseY - (mouseY - currentPos.y) * scaleRatio;
          
          setScale(newScale);
          setStagePosition({ x: newPosX, y: newPosY });
        } else {
          // PAN mode - two-finger swipe on trackpad
          setStagePosition(prev => ({
            x: prev.x - e.deltaX,
            y: prev.y - e.deltaY,
          }));
        }
      };
      
      container.addEventListener('wheel', handler, { passive: false });
      
      // Store handler ref for cleanup
      (container as HTMLDivElement & { _wheelHandler?: (e: WheelEvent) => void })._wheelHandler = handler;
    });
    
    return () => {
      cancelAnimationFrame(rafId);
      const container = containerRef.current;
      if (container) {
        const handler = (container as HTMLDivElement & { _wheelHandler?: (e: WheelEvent) => void })._wheelHandler;
        if (handler) {
          container.removeEventListener('wheel', handler);
        }
      }
    };
  }, [isMounted]);

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    
    if (toolMode === 'pan' || e.button === 1) {
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, stageX: stagePosition.x, stageY: stagePosition.y };
    } else if (toolMode === 'select') {
      // Start selection rectangle - clear selection and text edit state
      setSelectedIds([]);
      setTextEditState(null);
      setSelectedTextRegion(null);
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        selectionStartRef.current = { x, y };
        setSelectionRect({ startX: x, startY: y, x, y, w: 0, h: 0 });
      }
    }
  };

  useEffect(() => {
    if (!isPanning && !selectionRect) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (isPanning && panStartRef.current) {
        setStagePosition({
          x: panStartRef.current.stageX + (e.clientX - panStartRef.current.x),
          y: panStartRef.current.stageY + (e.clientY - panStartRef.current.y),
        });
      }
      if (selectionRect && selectionStartRef.current) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const currentX = e.clientX - rect.left;
          const currentY = e.clientY - rect.top;
          const x = Math.min(selectionStartRef.current.x, currentX);
          const y = Math.min(selectionStartRef.current.y, currentY);
          const w = Math.abs(currentX - selectionStartRef.current.x);
          const h = Math.abs(currentY - selectionStartRef.current.y);
          setSelectionRect({ ...selectionRect, x, y, w, h });
        }
      }
    };

    const handleMouseUp = () => {
      if (selectionRect && selectionRect.w > 5 && selectionRect.h > 5) {
        // Find elements inside selection
        const selected: string[] = [];
        elements.forEach(el => {
          const elLeft = el.x * scale + stagePosition.x;
          const elTop = el.y * scale + stagePosition.y;
          const elRight = elLeft + el.width * scale;
          const elBottom = elTop + el.height * scale;
          
          if (elLeft < selectionRect.x + selectionRect.w && elRight > selectionRect.x &&
              elTop < selectionRect.y + selectionRect.h && elBottom > selectionRect.y) {
            selected.push(el.id);
          }
        });
        setSelectedIds(selected);
      }
      setIsPanning(false);
      setSelectionRect(null);
      panStartRef.current = null;
      selectionStartRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPanning, selectionRect, elements, scale, stagePosition]);

  const handleElementChange = (id: string, newAttrs: Partial<CanvasElement>) => {
    setElements(prev => prev.map(el => el.id === id ? { ...el, ...newAttrs } : el));
  };

  const handleElementSelect = (id: string, e?: React.MouseEvent) => {
    // Shift+click to add/remove from selection
    if (e?.shiftKey) {
      setSelectedIds(prev => {
        if (prev.includes(id)) {
          // Remove from selection
          return prev.filter(i => i !== id);
        } else {
          // Add to selection
          return [...prev, id];
        }
      });
    } else {
      // Regular click - single select
      setSelectedIds([id]);
    }
    // Clear text edit state when selection changes
    if (textEditState && textEditState.elementId !== id) {
      setTextEditState(null);
    }
  };

  const [isSaving, setIsSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const isSavingRef = useRef(false);
  
  // Keep ref in sync
  useEffect(() => { isSavingRef.current = isSaving; }, [isSaving]);
  
  // Track unsaved changes
  useEffect(() => {
    if (canvasData && elements.length > 0) {
      const currentElementsJson = JSON.stringify(elements);
      const originalElementsJson = JSON.stringify(canvasData.elements || []);
      setHasUnsavedChanges(currentElementsJson !== originalElementsJson);
    }
  }, [elements, canvasData]);

  // Calculate next image position based on existing elements
  const getNextImagePosition = useCallback((imgWidth: number, imgHeight: number) => {
    const PADDING = 24;
    
    if (elements.length === 0) {
      // First image - center in visible area
      const centerX = (containerSize.width / 2 - stagePosition.x) / scale - imgWidth / 2;
      const centerY = (containerSize.height / 2 - stagePosition.y) / scale - imgHeight / 2;
      return { x: centerX, y: centerY };
    }
    
    // Find the rightmost edge of existing elements
    let maxRight = -Infinity;
    let topAtMaxRight = 0;
    elements.forEach(el => {
      const right = el.x + el.width;
      if (right > maxRight) {
        maxRight = right;
        topAtMaxRight = el.y;
      }
    });
    
    // Place new image to the right of the rightmost element with padding
    return { x: maxRight + PADDING, y: topAtMaxRight };
  }, [elements, containerSize, stagePosition, scale]);

  // Handle paste from clipboard
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    // Don't interfere with input fields
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    
    const items = e.clipboardData?.items;
    if (!items) return;
    
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        
        const reader = new FileReader();
        reader.onload = (event) => {
          const img = new Image();
          img.onload = () => {
            // Scale proportionally if larger than max size
            const maxSize = 800;
            let imgWidth = img.width;
            let imgHeight = img.height;
            if (imgWidth > maxSize || imgHeight > maxSize) {
              const scaleFactor = Math.min(maxSize / imgWidth, maxSize / imgHeight);
              imgWidth = Math.round(imgWidth * scaleFactor);
              imgHeight = Math.round(imgHeight * scaleFactor);
            }
            const { x, y } = getNextImagePosition(imgWidth, imgHeight);
            
            const newElement: CanvasElement = {
              id: `img-${Date.now()}`,
              type: 'image',
              src: event.target?.result as string,
              x, y,
              width: imgWidth,
              height: imgHeight,
              rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, locked: false,
              name: `pasted-image-${Date.now()}.png`,
            };
            setElements(prev => [...prev, newElement]);
            toast.success('Image pasted');
          };
          img.src = event.target?.result as string;
        };
        reader.readAsDataURL(file);
        break; // Only paste first image
      }
    }
  }, [getNextImagePosition]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      // Ctrl/Cmd + S to save
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (!isSavingRef.current) {
          document.getElementById('canvas-save-btn')?.click();
        }
        return;
      }
      
      // V without modifier = select tool, with modifier = paste (handled by paste event)
      if (e.key.toLowerCase() === 'v' && !e.metaKey && !e.ctrlKey) {
        setToolMode('select');
        return;
      }
      
      switch (e.key.toLowerCase()) {
        case 'h': setToolMode('pan'); break;
        case 'escape': 
          setSelectedIds([]); 
          setTextEditState(null);
          setSelectedTextRegion(null);
          break;
        case 'delete': case 'backspace':
          if (selectedIds.length > 0) {
            setElements(prev => prev.filter(el => !selectedIds.includes(el.id)));
            setSelectedIds([]);
            setTextEditState(null);
            setSelectedTextRegion(null);
          }
          break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('paste', handlePaste);
    };
  }, [selectedIds, handlePaste]);

  const handleSave = useCallback(async () => {
    if (!canvasData || !onSave) {
      toast.error('Cannot save - missing data or save handler');
      return;
    }
    
    setIsSaving(true);
    
    try {
      // Create updated canvas data with current elements
      // Base64 images are stored directly in the JSON
      const updatedCanvasData: CanvasData = {
        ...canvasData,
        elements: elements,
      };
      
      // Save the JSON
      await onSave(JSON.stringify(updatedCanvasData, null, 2));
      
      // Update canvasData to match saved state
      setCanvasData(updatedCanvasData);
      setHasUnsavedChanges(false);
      
      toast.success('Canvas saved');
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save canvas');
    } finally {
      setIsSaving(false);
    }
  }, [canvasData, elements, onSave]);

  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // Scale proportionally if larger than max size
        const maxSize = 800;
        let imgWidth = img.width;
        let imgHeight = img.height;
        if (imgWidth > maxSize || imgHeight > maxSize) {
          const scaleFactor = Math.min(maxSize / imgWidth, maxSize / imgHeight);
          imgWidth = Math.round(imgWidth * scaleFactor);
          imgHeight = Math.round(imgHeight * scaleFactor);
        }
        const { x, y } = getNextImagePosition(imgWidth, imgHeight);
        
        const newElement: CanvasElement = {
          id: `img-${Date.now()}`,
          type: 'image',
          src: event.target?.result as string,
          x, y,
          width: imgWidth,
          height: imgHeight,
          rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, locked: false,
          name: file.name,
        };
        setElements(prev => [...prev, newElement]);
        toast.success(`Added ${file.name}`);
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (!isMounted) {
    return <div className="flex items-center justify-center h-full w-full bg-card"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (!content) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full gap-4 bg-card">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <div className="text-muted-foreground text-center">
          <p>No canvas content</p>
          <p className="text-sm">File: {filePath || 'unknown'}</p>
        </div>
      </div>
    );
  }

  if (!canvasData && content) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full gap-4 bg-card">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <div className="text-muted-foreground text-center">Failed to parse canvas</div>
      </div>
    );
  }

  const selectedElement = selectedIds.length === 1 ? elements.find(el => el.id === selectedIds[0]) : null;

  return (
    <div className={cn("flex flex-col h-full w-full", className)} style={{ backgroundColor: canvasData?.background || '#1a1a1a' }}>
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-2">
          <TooltipProvider delayDuration={0}>
            <div className="flex items-center border border-border rounded-full px-1 py-0.5">
              <Tooltip><TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className={cn("h-7 w-7 rounded-full", toolMode === 'select' && "bg-primary text-primary-foreground")} onClick={() => setToolMode('select')}>
                  <MousePointer2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger><TooltipContent>Select (V)</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className={cn("h-7 w-7 rounded-full", toolMode === 'pan' && "bg-primary text-primary-foreground")} onClick={() => setToolMode('pan')}>
                  <Hand className="h-4 w-4" />
                </Button>
              </TooltipTrigger><TooltipContent>Pan (H)</TooltipContent></Tooltip>
            </div>

            <div className="flex items-center border border-border rounded-full px-1 py-0.5">
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={handleZoomOut}><Minus className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Zoom Out</TooltipContent></Tooltip>
              <span className="text-xs text-muted-foreground px-2 min-w-[3rem] text-center">{Math.round(scale * 100)}%</span>
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={handleZoomIn}><Plus className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Zoom In</TooltipContent></Tooltip>
            </div>

            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleResetView}><Maximize className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Reset View</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button id="canvas-save-btn" variant="ghost" size="icon" className={cn("h-8 w-8 relative", hasUnsavedChanges && "text-primary")} onClick={handleSave} disabled={isSaving || !onSave}>{isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{hasUnsavedChanges && <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-primary rounded-full" />}</Button></TooltipTrigger><TooltipContent>{isSaving ? 'Saving...' : hasUnsavedChanges ? 'Save changes (⌘S)' : 'No changes'}</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleUploadClick}><ImagePlus className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Add Image</TooltipContent></Tooltip>
          </TooltipProvider>
        </div>
        <div className="text-sm text-muted-foreground">{canvasData?.name || fileName?.replace('.kanvax', '')}</div>
      </div>

      {/* Canvas */}
      <div 
        ref={containerRef} 
        className="flex-1 relative overflow-hidden"
        style={{ 
          cursor: isPanning ? 'grabbing' : toolMode === 'pan' ? 'grab' : selectionRect ? 'crosshair' : 'default',
          touchAction: 'none', // Prevent default touch behaviors
        }}
        onMouseDown={handleCanvasMouseDown}
      >
        {/* Grid */}
        <div className="absolute inset-0 pointer-events-none opacity-10" style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
          backgroundSize: `${50 * scale}px ${50 * scale}px`,
          backgroundPosition: `${stagePosition.x}px ${stagePosition.y}px`,
        }} />

        {elements.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center text-muted-foreground">
              <ImagePlus className="h-16 w-16 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">Canvas is empty</p>
              <p className="text-sm mt-1">Add images to get started</p>
            </div>
          </div>
        )}

        {elements.map((element) => (
          <CanvasImageElement
            key={element.id}
            element={element}
            isSelected={selectedIds.includes(element.id)}
            onSelect={(e) => handleElementSelect(element.id, e)}
            onChange={(newAttrs) => handleElementChange(element.id, newAttrs)}
            authToken={authToken}
            sandboxId={sandboxId}
            scale={scale}
            stagePosition={stagePosition}
            isProcessing={processingElementId === element.id}
          />
        ))}

        {/* Text Edit Overlay - rendered at canvas level for proper pan/zoom sync */}
        {textEditState && selectedIds.length === 1 && (() => {
          const selectedElement = elements.find(el => el.id === textEditState.elementId);
          if (!selectedElement) return null;
          
          // The element dimensions vs actual image dimensions may differ (object-fit: contain)
          // We need to calculate where the image actually renders within the element
          const elementWidth = selectedElement.width;
          const elementHeight = selectedElement.height;
          const ocrWidth = textEditState.ocrImageSize.width;
          const ocrHeight = textEditState.ocrImageSize.height;
          
          // Calculate how image fits in element (object-fit: contain behavior)
          const elementAspect = elementWidth / elementHeight;
          const imageAspect = ocrWidth / ocrHeight;
          
          let displayWidth: number, displayHeight: number, offsetX: number, offsetY: number;
          
          if (imageAspect > elementAspect) {
            // Image is wider - fit to width, letterbox top/bottom
            displayWidth = elementWidth;
            displayHeight = elementWidth / imageAspect;
            offsetX = 0;
            offsetY = (elementHeight - displayHeight) / 2;
          } else {
            // Image is taller - fit to height, letterbox left/right
            displayHeight = elementHeight;
            displayWidth = elementHeight * imageAspect;
            offsetX = (elementWidth - displayWidth) / 2;
            offsetY = 0;
          }
          
          // Calculate the actual image position in screen coordinates
          const imageScreenX = (selectedElement.x + offsetX) * scale + stagePosition.x;
          const imageScreenY = (selectedElement.y + offsetY) * scale + stagePosition.y;
          const imageScreenWidth = displayWidth * scale;
          const imageScreenHeight = displayHeight * scale;
          
          
          return (
            <div 
              className="absolute pointer-events-none z-[50] overflow-hidden"
              style={{
                left: imageScreenX,
                top: imageScreenY,
                width: imageScreenWidth,
                height: imageScreenHeight,
              }}
            >
              {textEditState.regions.map((region) => {
                // Calculate position as percentage of OCR image dimensions
                const left = (region.bbox.x0 / ocrWidth) * 100;
                const top = (region.bbox.y0 / ocrHeight) * 100;
                const width = ((region.bbox.x1 - region.bbox.x0) / ocrWidth) * 100;
                const height = ((region.bbox.y1 - region.bbox.y0) / ocrHeight) * 100;
                const isSelected = selectedTextRegion?.id === region.id;
                
                return (
                  <div
                    key={region.id}
                    className={cn(
                      "absolute cursor-pointer border-2 transition-all pointer-events-auto",
                      isSelected 
                        ? "border-blue-500 bg-blue-500/20" 
                        : "border-blue-400/50 hover:border-blue-500 hover:bg-blue-500/10"
                    )}
                    style={{
                      left: `${left}%`,
                      top: `${top}%`,
                      width: `${width}%`,
                      height: `${height}%`,
                    }}
                    onClick={() => setSelectedTextRegion(region)}
                    title={region.text}
                  />
                );
              })}
            </div>
          );
        })()}

        {/* Selection rectangle - blue */}
        {selectionRect && selectionRect.w > 0 && selectionRect.h > 0 && (
          <div
            className="absolute border border-dashed border-blue-500 bg-blue-500/10 pointer-events-none"
            style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.w, height: selectionRect.h }}
          />
        )}

        {/* Floating AI toolbar - single selection */}
        {selectedIds.length === 1 && selectedElement && (
          <FloatingToolbar
            element={selectedElement}
            scale={scale}
            stagePosition={stagePosition}
            onDuplicate={() => {
              const newEl = { ...selectedElement, id: `img-${Date.now()}`, x: selectedElement.x + selectedElement.width + 24, y: selectedElement.y };
              setElements(prev => [...prev, newEl]);
              setSelectedIds([newEl.id]);
            }}
            onDelete={() => { 
              setElements(prev => prev.filter(el => el.id !== selectedElement.id)); 
              setSelectedIds([]);
              setTextEditState(null);
              setSelectedTextRegion(null);
            }}
            onDownload={() => {
              if (selectedElement.src.startsWith('data:')) {
                const link = document.createElement('a');
                link.href = selectedElement.src;
                link.download = selectedElement.name || 'image.png';
                link.click();
              } else {
                toast.info('Downloading from sandbox...');
              }
            }}
            onImageUpdate={(newSrc, newDimensions) => {
              if (newDimensions) {
                // Update src and resize element to new dimensions
                handleElementChange(selectedElement.id, { 
                  src: newSrc, 
                  width: newDimensions.width,
                  height: newDimensions.height,
                });
              } else {
                handleElementChange(selectedElement.id, { src: newSrc });
              }
            }}
            onProcessingChange={(isProcessing) => {
              setProcessingElementId(isProcessing ? selectedElement.id : null);
            }}
            onTextEditStateChange={(state) => {
              if (state) {
                setTextEditState({ elementId: selectedElement.id, regions: state.regions, ocrImageSize: state.ocrImageSize });
              } else {
                setTextEditState(null);
                setSelectedTextRegion(null);
              }
            }}
            onTextRegionSelect={(region) => setSelectedTextRegion(region)}
            externalSelectedRegion={selectedTextRegion}
            authToken={authToken}
            sandboxId={sandboxId}
          />
        )}

        {/* Multi-select toolbar */}
        {selectedIds.length > 1 && (
          <MultiSelectToolbar
            elements={elements.filter(el => selectedIds.includes(el.id))}
            scale={scale}
            stagePosition={stagePosition}
            onStartMerge={() => {
              // Get the first selected element's size for the merged result
              const selectedEls = elements.filter(el => selectedIds.includes(el.id));
              const firstEl = selectedEls[0];
              
              // Get bounds to position new image to the right
              const bounds = selectedEls.reduce((acc, el) => ({
                maxX: Math.max(acc.maxX, el.x + el.width),
                minY: Math.min(acc.minY, el.y),
              }), { maxX: -Infinity, minY: Infinity });
              
              // Create temporary placeholder element - use first image's size
              const tempId = `merge-temp-${Date.now()}`;
              const tempElement: CanvasElement = {
                id: tempId,
                type: 'image',
                src: '', // Empty - will show as loading placeholder
                name: 'Merging...',
                x: bounds.maxX + 24, // Place to the right of rightmost selected image
                y: bounds.minY,
                width: firstEl?.width || 400,
                height: firstEl?.height || 400,
                visible: true,
              };
              
              // KEEP original elements, just add the temp placeholder
              setElements(prev => [...prev, tempElement]);
              setSelectedIds([tempId]);
              setProcessingElementId(tempId); // Show shimmer on it
              
              return tempId;
            }}
            onMergeComplete={(tempId, mergedImageSrc) => {
              // Replace temp element with actual merged image
              setElements(prev => prev.map(el => 
                el.id === tempId 
                  ? { ...el, src: mergedImageSrc, name: 'merged-image.png' }
                  : el
              ));
              setProcessingElementId(null);
            }}
            onMergeFailed={(tempId) => {
              // Remove the temp element on failure
              setElements(prev => prev.filter(el => el.id !== tempId));
              setSelectedIds([]);
              setProcessingElementId(null);
            }}
            onDelete={() => {
              setElements(prev => prev.filter(el => !selectedIds.includes(el.id)));
              setSelectedIds([]);
            }}
            onProcessingChange={(isProcessing) => {
              // Set processing for all selected elements
              setProcessingElementId(isProcessing ? selectedIds[0] : null);
            }}
            authToken={authToken}
            sandboxId={sandboxId}
          />
        )}
      </div>
    </div>
  );
}
