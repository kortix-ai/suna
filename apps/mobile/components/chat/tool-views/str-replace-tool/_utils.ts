import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface StrReplaceData {
  filePath: string | null;
  oldStr: string | null;
  newStr: string | null;
  success: boolean;
}

export interface LineDiff {
  type: 'added' | 'removed' | 'unchanged';
  lineNumber: number;
  oldLine: string | null;
  newLine: string | null;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  unchanged: number;
}

export function extractStrReplaceData(toolData: ParsedToolData): StrReplaceData {
  const { arguments: args, result } = toolData;
  
  return {
    filePath: args?.file_path || null,
    oldStr: args?.old_str || null,
    newStr: args?.new_str || null,
    success: result.success ?? true
  };
}

export function generateLineDiff(oldStr: string, newStr: string): LineDiff[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const diff: LineDiff[] = [];
  
  const maxLines = Math.max(oldLines.length, newLines.length);
  
  for (let i = 0; i < maxLines; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : null;
    const newLine = i < newLines.length ? newLines[i] : null;
    
    if (oldLine === newLine) {
      diff.push({
        type: 'unchanged',
        lineNumber: i + 1,
        oldLine,
        newLine
      });
    } else if (oldLine !== null && newLine === null) {
      diff.push({
        type: 'removed',
        lineNumber: i + 1,
        oldLine,
        newLine: null
      });
    } else if (oldLine === null && newLine !== null) {
      diff.push({
        type: 'added',
        lineNumber: i + 1,
        oldLine: null,
        newLine
      });
    } else {
      diff.push({
        type: 'removed',
        lineNumber: i + 1,
        oldLine,
        newLine: null
      });
      diff.push({
        type: 'added',
        lineNumber: i + 1,
        oldLine: null,
        newLine
      });
    }
  }
  
  return diff;
}

export function calculateDiffStats(lineDiff: LineDiff[]): DiffStats {
  return lineDiff.reduce(
    (stats, line) => {
      if (line.type === 'added') stats.additions++;
      else if (line.type === 'removed') stats.deletions++;
      else stats.unchanged++;
      return stats;
    },
    { additions: 0, deletions: 0, unchanged: 0 }
  );
}

