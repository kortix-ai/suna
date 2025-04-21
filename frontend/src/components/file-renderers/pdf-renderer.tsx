"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { Worker, Viewer } from '@react-pdf-viewer/core';
import { defaultLayoutPlugin } from '@react-pdf-viewer/default-layout';

// Import styles
import '@react-pdf-viewer/core/lib/styles/index.css';
import '@react-pdf-viewer/default-layout/lib/styles/index.css';

interface PdfRendererProps {
  url: string;
  className?: string;
}

export function PdfRenderer({ url, className }: PdfRendererProps) {
  // Create the default layout plugin instance
  const defaultLayoutPluginInstance = defaultLayoutPlugin();
  
  return (
    <div className={cn("flex flex-col w-full h-full", className)}>
      <div className="flex-1 overflow-hidden rounded-md">
        <Worker workerUrl={`https://unpkg.com/pdfjs-dist@3.4.120/build/pdf.worker.min.js`}>
          <Viewer
            fileUrl={url}
            plugins={[defaultLayoutPluginInstance]}
            defaultScale={1}
          />
        </Worker>
      </div>
    </div>
  );
} 