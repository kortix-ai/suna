'use client';

import React from 'react';
import { FileArtifactCard, type FileArtifactMessage } from './FileArtifactCard';

export interface CanvasEventMessage {
  type: 'canvas';
  kind: string;
  id: string;
  data: unknown;
}

interface CanvasMessageRendererProps {
  message: CanvasEventMessage;
  className?: string;
}

/**
 * Routes a CanvasMessage to the correct card component based on `kind`.
 * Returns null for unrecognised kinds so the caller can skip rendering.
 */
export function CanvasMessageRenderer({ message, className }: CanvasMessageRendererProps) {
  switch (message.kind) {
    case 'file_artifact':
      return (
        <FileArtifactCard
          message={message as FileArtifactMessage}
          className={className}
        />
      );
    default:
      return null;
  }
}
