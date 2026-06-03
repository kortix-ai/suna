/**
 * Utility functions for Mermaid diagram detection and processing
 */

/**
 * Detects if a code block contains Mermaid syntax
 */
export function isMermaidCode(language: string, code: string): boolean {
  if (!code?.trim()) return false;

  // Check if language is explicitly mermaid
  if (language === 'mermaid') return true;

  // For unknown languages, only check if content STARTS with a mermaid diagram
  // This prevents false positives from content that happens to contain mermaid keywords
  if (!language || language === 'text' || language === 'plain') {
    const trimmed = code.trim();
    const firstLine = trimmed.split('\n')[0]?.toLowerCase().trim();

    const mermaidStarters = [
      'graph',
      'flowchart',
      'sequencediagram',
      'classdiagram',
      'statediagram',
      'erdiagram',
      'journey',
      'gantt',
      'pie',
      'gitgraph',
      'mindmap',
      'timeline',
      'sankey',
      'block',
      'quadrant',
      'requirement',
      'c4context',
      'c4container',
      'c4component',
      'c4dynamic',
      // Git graph specific patterns (gitgraph starts with these commands)
      'commit',
      'branch',
      'checkout',
      'merge'
    ];

    // Only treat as Mermaid if the first line starts with a diagram declaration
    return mermaidStarters.some(starter => firstLine.startsWith(starter.toLowerCase()));
  }

  return false;
}
