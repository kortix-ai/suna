'use client';

import type { MarkdownTrust } from '@/components/markdown/markdown-policy';

export interface GenuiMessageBlockProps {
  code: string;
  version: number;
  isStreaming: boolean;
  trust: MarkdownTrust;
}

export default function GenuiMessageBlock(_props: GenuiMessageBlockProps) {
  return null;
}
