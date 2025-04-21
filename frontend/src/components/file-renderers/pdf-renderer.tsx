"use client";

import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { 
  ZoomIn, 
  ZoomOut, 
  RotateCw, 
  Download, 
  ArrowLeft, 
  ArrowRight,
  Fullscreen,
  Loader
} from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';

// Initialize pdfjs worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`;

interface PdfRendererProps {
  url: string;
  className?: string;
}

export function PdfRenderer({ url, className }: PdfRendererProps) {
  // State for zoom and rotation controls
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  // Handle zoom in/out
  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.2, 2.0));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.2, 0.5));
  
  // Handle rotation
  const handleRotate = () => setRotation(prev => (prev + 90) % 360);
  
  // Handle download
  const handleDownload = () => {
    const link = document.createElement('a');
    link.href = url;
    link.download = url.split('/').pop() || 'document.pdf';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  
  // Handle page navigation
  const goToPrevPage = () => setPageNumber(prev => Math.max(prev - 1, 1));
  const goToNextPage = () => {
    if (numPages !== null) {
      setPageNumber(prev => Math.min(prev + 1, numPages));
    }
  };
  
  // Handle document loading
  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setIsLoading(false);
  };
  
  const onDocumentLoadError = (error: Error) => {
    console.error("Error loading PDF:", error);
    setError(error);
    setIsLoading(false);
  };
  
  // Handle fullscreen
  const handleFullscreen = () => {
    const pdfContainer = document.getElementById('pdf-container');
    if (pdfContainer) {
      if (pdfContainer.requestFullscreen) {
        pdfContainer.requestFullscreen();
      }
    }
  };
  
  return (
    <div className={cn("flex flex-col w-full h-full", className)}>
      {/* Controls */}
      <div className="flex items-center justify-between py-2 px-4 bg-muted/30 border-b mb-2 rounded-t-md">
        <div className="flex items-center space-x-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleZoomOut}
            title="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-xs font-medium">{Math.round(zoom * 100)}%</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleZoomIn}
            title="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleRotate}
            title="Rotate"
          >
            <RotateCw className="h-4 w-4" />
          </Button>
        </div>
        
        <div className="flex items-center space-x-2">
          {numPages && (
            <div className="flex items-center space-x-2 mr-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={goToPrevPage}
                disabled={pageNumber <= 1}
                title="Previous page"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs font-medium">
                {pageNumber} / {numPages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={goToNextPage}
                disabled={pageNumber >= (numPages || 1)}
                title="Next page"
              >
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleFullscreen}
            title="Fullscreen"
          >
            <Fullscreen className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleDownload}
            title="Download"
          >
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </div>
      
      {/* PDF Viewer */}
      <div id="pdf-container" className="flex-1 overflow-auto rounded-b-md bg-white flex justify-center">
        {isLoading && (
          <div className="flex items-center justify-center w-full h-full">
            <Loader className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}
        
        {error && (
          <div className="flex flex-col items-center justify-center w-full h-full text-destructive p-4 text-center">
            <p className="font-semibold">Failed to load PDF</p>
            <p className="text-sm mt-2">{error.message}</p>
          </div>
        )}
        
        <Document
          file={url}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={onDocumentLoadError}
          loading={null}
          className="mx-auto"
        >
          {!isLoading && !error && (
            <Page
              pageNumber={pageNumber}
              scale={zoom}
              rotate={rotation}
              renderTextLayer={true}
              renderAnnotationLayer={true}
              className="shadow-md"
            />
          )}
        </Document>
      </div>
    </div>
  );
} 