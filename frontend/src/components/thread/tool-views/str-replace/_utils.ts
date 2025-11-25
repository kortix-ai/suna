import {
  DiffType,
  LineDiff,
  CharDiffPart,
  DiffStats,
  generateLineDiff,
  generateCharDiff,
  calculateDiffStats,
} from '../file-operation/_utils';

export type { DiffType, LineDiff, CharDiffPart, DiffStats };
export { generateLineDiff, generateCharDiff, calculateDiffStats };

export interface ExtractedData {
  filePath: string | null;
  oldStr: string | null;
  newStr: string | null;
  success?: boolean;
  timestamp?: string;
}


