'use client';

import React from 'react';
import { PrSummaryCard, type PrSummaryMessage } from './PrSummaryCard';

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
 * Routes a CanvasMessage to the appropriate card component based on `kind`.
 * Add new kinds here as they are implemented.
 */
export function CanvasMessageRenderer({ message, className }: CanvasMessageRendererProps) {
  switch (message.kind) {
    case 'pr_summary':
      return (
        <PrSummaryCard
          message={message as PrSummaryMessage}
          className={className}
        />
      );

    default:
      return null;
  }
}
