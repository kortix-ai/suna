import { ToolCallData, ToolResultData } from '../types';

export interface FileReadResult {
  file_path: string;
  success: boolean;
  file_type?: string;
  extraction_method?: string;
  size_bytes?: number;
  content_length?: number;
  truncated?: boolean;
  content?: string;
  error?: string;
}

export interface SearchHit {
  file: string;
  score: number;
  content: string;
}

export interface FileSearchData {
  query: string;
  totalHits: number;
  results: SearchHit[];
  note?: string;
}

export interface FileReaderData {
  filePaths: string[];
  isBatch: boolean;
  isSearch: boolean;
  searchData: FileSearchData | null;
  results: FileReadResult[];
  message: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp: string | null;
  actualAssistantTimestamp: string | null;
}

export function extractFileReaderData(
  toolCall: ToolCallData,
  toolResult: ToolResultData | undefined,
  isSuccess: boolean,
  toolTimestamp: string | undefined,
  assistantTimestamp: string | undefined
): FileReaderData {
  const args = toolCall.arguments || {};
  const filePath = args.file_path;
  const filePaths = args.file_paths;
  const query = args.query;
  
  const functionName = toolCall.function_name?.toLowerCase() || '';
  const isSearch = functionName.includes('search');
  
  const isBatch = !!filePaths && Array.isArray(filePaths);
  const pathList = isBatch ? filePaths : (filePath ? [filePath] : []);
  
  let results: FileReadResult[] = [];
  let searchData: FileSearchData | null = null;
  let message: string | null = null;
  let actualIsSuccess = isSuccess;
  
  if (toolResult?.output) {
    const output = toolResult.output;
    
    if (typeof output === 'object') {
      if (isSearch && output.query !== undefined) {
        searchData = {
          query: output.query || query || '',
          totalHits: output.total_hits || 0,
          results: (output.results || []).map((r: any) => ({
            file: r.file || '',
            score: r.score || 0,
            content: r.content || ''
          })),
          note: output.note
        };
        actualIsSuccess = true;
      } else if (output.results && Array.isArray(output.results)) {
        if (isSearch) {
          searchData = {
            query: query || '',
            totalHits: output.results.length,
            results: output.results.map((r: any) => ({
              file: r.file || r.file_path || '',
              score: r.score || 0,
              content: r.content || ''
            })),
            note: output.note
          };
        } else {
          results = output.results;
        }
        message = output.message || null;
        actualIsSuccess = isSearch ? true : results.some(r => r.success);
      } else if (output.content !== undefined) {
        results = [{
          file_path: output.file_path || pathList[0] || 'unknown',
          success: output.success !== false,
          file_type: output.file_type,
          extraction_method: output.extraction_method,
          size_bytes: output.size_bytes,
          content_length: output.content_length,
          truncated: output.truncated,
          content: output.content,
          error: output.error
        }];
        actualIsSuccess = output.success !== false;
      } else if (output.error) {
        results = [{
          file_path: pathList[0] || 'unknown',
          success: false,
          error: output.error
        }];
        actualIsSuccess = false;
      }
    } else if (typeof output === 'string') {
      try {
        const parsed = JSON.parse(output);
        if (parsed.results) {
          results = parsed.results;
          message = parsed.message || null;
        } else if (parsed.content !== undefined) {
          results = [parsed];
        }
      } catch {
        results = [{
          file_path: pathList[0] || 'unknown',
          success: true,
          content: output
        }];
      }
    }
  }
  
  return {
    filePaths: pathList,
    isBatch,
    isSearch,
    searchData,
    results,
    message,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp || null,
    actualAssistantTimestamp: assistantTimestamp || null
  };
}

export function getFileTypeIcon(fileType: string | undefined): string {
  switch (fileType) {
    case 'pdf':
      return 'pdf';
    case 'doc':
    case 'docx':
      return 'doc';
    case 'ppt':
    case 'pptx':
      return 'presentation';
    case 'xls':
    case 'xlsx':
    case 'csv':
      return 'spreadsheet';
    case 'text':
      return 'text';
    default:
      return 'file';
  }
}

export function formatFileSize(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
