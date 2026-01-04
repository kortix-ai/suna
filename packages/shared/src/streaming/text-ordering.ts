/**
 * Text content ordering utilities for streaming messages
 * Handles sequence-based ordering of text chunks
 */

/**
 * Text chunk with optional sequence number
 */
export interface TextChunk {
  content: string;
  sequence?: number;
}

/**
 * Check if chunks need sorting based on sequence numbers
 */
export function needsSorting(chunks: TextChunk[]): boolean {
  if (chunks.length <= 1) return false;
  
  for (let i = 1; i < chunks.length; i++) {
    const prevSeq = chunks[i - 1].sequence ?? 0;
    const currSeq = chunks[i].sequence ?? 0;
    if (currSeq < prevSeq) {
      return true;
    }
  }
  
  return false;
}

/**
 * Order content chunks by sequence number and concatenate
 * Optimized to avoid sorting if already in order
 */
export function orderContentBySequence(chunks: TextChunk[]): string {
  if (chunks.length === 0) return '';
  
  // Only sort if sequences are out of order (optimization)
  if (!needsSorting(chunks)) {
    // If already sorted, just concatenate
    let result = '';
    for (let i = 0; i < chunks.length; i++) {
      result += chunks[i].content;
    }
    return result;
  }
  
  // Only sort if necessary
  const sorted = chunks.slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  let result = '';
  for (let i = 0; i < sorted.length; i++) {
    result += sorted[i].content;
  }
  return result;
}

