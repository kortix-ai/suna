'use client';

import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Document, Page, pdfjs } from 'react-pdf';

// Import styles for annotations and text layer
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface PdfRendererProps {
  url: string;
  className?: string;
}

export function PdfRenderer({ url, className }: PdfRendererProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);

  function onDocumentLoadSuccess({ numPages }: { numPages: number }): void {
    setNumPages(numPages);
  }

  function changePage(offset: number) {
    setPageNumber((prevPageNumber) => {
      const newPageNumber = prevPageNumber + offset;
      return newPageNumber >= 1 && newPageNumber <= (numPages || 1)
        ? newPageNumber
        : prevPageNumber;
    });
  }

  function previousPage() {
    changePage(-1);
  }

  function nextPage() {
    changePage(1);
  }

  function zoomIn() {
    setScale((prevScale) => Math.min(prevScale + 0.2, 3.0));
  }

  function zoomOut() {
    setScale((prevScale) => Math.max(prevScale - 0.2, 0.5));
  }

  return (
    <div className={cn('flex flex-col w-full h-full', className)}>
      <div className="flex-1 overflow-auto rounded-md">
        <Document
          file={url}
          onLoadSuccess={onDocumentLoadSuccess}
          className="flex flex-col items-center"
        >
          <Page
            pageNumber={pageNumber}
            scale={scale}
            renderTextLayer={true}
            renderAnnotationLayer={true}
          />
        </Document>
      </div>

      {numPages && (
        <div className="flex items-center justify-between p-2 bg-background border-t">
          <div className="flex items-center space-x-2">
            <button
              onClick={zoomOut}
              className="px-2 py-1 bg-muted rounded hover:bg-muted/80"
              disabled={scale <= 0.5}
            >
              -
            </button>
            <span>{Math.round(scale * 100)}%</span>
            <button
              onClick={zoomIn}
              className="px-2 py-1 bg-muted rounded hover:bg-muted/80"
              disabled={scale >= 3.0}
            >
              +
            </button>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={previousPage}
              className="px-2 py-1 bg-muted rounded hover:bg-muted/80"
              disabled={pageNumber <= 1}
            >
              Previous
            </button>
            <span>
              Page {pageNumber} of {numPages}
            </span>
            <button
              onClick={nextPage}
              className="px-2 py-1 bg-muted rounded hover:bg-muted/80"
              disabled={pageNumber >= numPages}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
