import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface SheetsData {
  filePath: string | null;
  fileName: string | null;
  action: string;
  headers: string[];
  rows: any[][];
  success: boolean;
}

const parseContent = (content: any): any => {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }
  return content;
};

export function extractSheetsData(toolData: ParsedToolData): SheetsData {
  const { result, toolName } = toolData;
  
  let filePath: string | null = null;
  let headers: string[] = [];
  let rows: any[][] = [];
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    if (output && typeof output === 'object') {
      filePath = output.created || output.updated || output.file_path || output.formatted || output.chart_saved || null;
      
      if (output.result_preview) {
        headers = output.result_preview.headers || [];
        rows = output.result_preview.rows || [];
      } else {
        headers = output.headers || output.columns || [];
        rows = output.rows || output.sample_rows || output.data || [];
      }
    }
  }
  
  const action = getActionName(toolName || '');
  const fileName = filePath ? filePath.split('/').pop() || null : null;
  
  return {
    filePath,
    fileName,
    action,
    headers,
    rows,
    success: result.success ?? true
  };
}

function getActionName(toolName: string): string {
  const name = toolName.toLowerCase().replace(/_/g, '-');
  
  if (name.includes('create')) return 'Created';
  if (name.includes('update')) return 'Updated';
  if (name.includes('view')) return 'Viewing';
  if (name.includes('analyze')) return 'Analyzed';
  if (name.includes('visualize')) return 'Visualized';
  if (name.includes('format')) return 'Formatted';
  
  return 'Sheet';
}

